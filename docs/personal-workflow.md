# Personal fork: agent workflow

`origin` is `simon-ami/ardia`. `upstream` is `mantrakp04/ardia`.
Use task branches in this checkout. Preserve unrelated work. Do not use worktrees or subagents.
Run tools, dependency installs, builds, checks, installation, and cleanup yourself. T3 buttons are optional.
Use the existing build locks. Keep test instances hidden and use scratch data.

Local commits are authorized. Wait for Simon's required manual tests before committing.
Ask before pushing, opening PRs, or removing custom feature code. Reuse approval already given for this task.
Do not publish releases or deploy sites. Keep the official app and its profile unchanged.
Write brief reports and collaboration text in roughly 80% ASD-STE100. State both what changed and how.
For copies, name what stays shared and what becomes independent.

## Start any task

1. Check Git status. Run `python3 scripts/personal/status.py` to compare candidate and installed build records
   with current sources. An older unrecorded build needs one full recorded build, not another profile migration.
2. Read [the ledger](custom-features.md). Load feature records relevant to the task; review all active records
   for an upstream update. Use source diffs and relevant PR metadata to narrow investigation.
3. Select the change and check engine availability before spending time on implementation or building.
   Do not replace a missing engine with an older one or start a full Chromium build without discussing its cost.
4. Decide the smallest useful checks and whether Simon needs a manual test. Do not repeat setup checks
   whose inputs and behavior are unchanged.

## Upstream update

1. Fetch release metadata and refs. Select the newest published stable or nightly release by version order.
   Stable wins over nightlies of the same version. Do not use `main` unless Simon explicitly requests it.
   Resolve the tag to a full commit; record both. Ask if release order is ambiguous.
2. Compare the target with the fork and active feature requirements. Check relevant upstream code and PRs
   for merged or alternative implementations. Search by behavior, not only titles.
   Untouched code and unrelated PRs do not require exhaustive rereading.
   Prefer upstream when it provides the same value or more. For partial coverage, use upstream as the base
   and adapt only the missing behavior or styling when practical. Prepare that variant for Simon to test
   before finalizing replacements or retiring custom features.
3. Merge on an update branch. Keep newer fork commits. Resolve mechanical conflicts yourself.
   Ask when a conflict changes intended behavior. Ask before removing custom code, even if upstream replaces it.
4. Follow the checks and delivery rules below. No new release means report that no update is needed.

## A specific upstream PR or branch

1. Read the PR, changes, checks, and dependencies. Fetch its exact head and record the PR URL and full commit.
   For a branch, identify the requested change and its base. Do not merge an entire contributor branch blindly.
2. Check whether the fork already has equivalent changes. Identify dependencies outside the requested change,
   including engine changes. Explain material differences or extra scope before proceeding.
3. Select the focused commits, or port the change when their context does not fit. Keep provenance and explain
   significant adaptations. Preserve author attribution. Resolve routine compatibility changes yourself.
4. Add an individual ledger record in the ledger's compact format. Follow normal checks, manual tests, and delivery.
   Do not open a duplicate upstream PR for someone else's existing contribution.

## A new feature or adjustment

1. Check current behavior and upstream's open, merged, and relevant closed PRs for the requested outcome.
2. If an existing solution fits, link it and explain differences before using it. Ask only if the choice changes
   required behavior or scope. Otherwise implement the feature or adjustment on a task branch.
3. Check the changed behavior, request a focused manual test if needed, and rewrite its current ledger record.
   Follow the ledger's maintenance format; do not append a build/install history.

## Check and build in proportion

| Change | Local checks |
| --- | --- |
| Documentation only | Review links and instructions; no app build or signing. |
| JS or UI | Affected tests and typecheck. Use Metro with compatible Debug during iteration if useful. |
| Native app code or dependencies | Native compilation, affected tests, and hidden app exercise. |
| Broad upstream or engine update | Review affected customizations, matching engine, broader regression checks. |
| Signing, storage, profile formats, or lifecycle scripts | Relevant failure, persistence, backup, and rollback checks. |
| CLI only | CLI checks; reuse the unchanged app binary when possible. |

Follow this workflow and [the repository testing policy](testing.md#whats-kept-and-why) when choosing checks.
Do not invoke a separate testing skill unless Simon explicitly asks. Prefer existing app exercises and affected
regression tests. Add tests for data loss, privacy, integration boundaries, or a demonstrated regression that is
hard to catch by eye. Do not add tests that only restate implementation details or visual constants.
For small UI changes, a hidden scratch launch plus Simon's manual interaction and appearance check is sufficient
alongside typecheck and affected existing tests. Automate repeated E2E checks when their value justifies upkeep.
Use golden fixtures only with independently reviewed expected results; never accept regenerated output blindly.

Run the required full CI on the PR. Do not duplicate it locally for small changes.
Use a local full suite when broad or risky changes justify catching regressions before manual testing.
Run performance checks only for relevant changes or a measured regression. After a fix, rerun the failed area;
passing checks stay valid until their relevant inputs change.

Install dependencies only when manifests, lockfiles, native integration, or missing dependencies require it.
Use `scripts/agent/locked pod` for dependency installation. Prefer the pinned package manager.
Debug is an iteration tool, not a mandatory step before every Release. Native changes need recompilation,
which can be the Release build when that is the shortest useful route.

## Deliver the complete personal app

1. Run available source-level checks before building. Run `python3 scripts/personal/build-app.py`.
   It prepares the matching engine, reuses a recorded unchanged
   Release or builds one, prepares the matching CLI without activating it, and signs the candidate with
   Simon's existing certificate. During an uncommitted update merge, it matches the staged engine tree;
   unstaged or untracked engine files block prebuilt lookup. It bundles JavaScript; the delivered app never depends on Metro.
   If needed, request the signing password through the private secret tool. Never put it in logs, arguments,
   Git, or a persistent script. Use one private password file within the task; remove that temporary file when done.
2. Run the relevant automated checks and a hidden scratch launch. Check the new signed build record and
   any affected personal-build invariants. Read [personal-app.md](personal-app.md) for storage details.
   `--sign-only` is only for a recorded build whose inputs and program files still match.
   After candidate tests, unregister that build with `lsregister -u` and register the installed personal app
   with `lsregister -f`, unless installing immediately. Do not leave build copies as browser-handler candidates.
3. Give Simon only the required manual steps and expected results. Use a scratch profile for candidate tests.
   If real-profile behavior needs validation, install with a backup first and test it there. Never run the build
   and installed app against the personal profile at the same time. Do not launch a candidate on real data
   before taking a backup. The official profile is never the routine test source.
4. Let Simon keep using the installed app during preparation. Ask him to quit it only for installation.
   Run `python3 scripts/personal/install-app.py` once checks allow installation. It validates the recorded
   candidate, snapshots the personal profile and preferences, preserves the current app and CLI reference,
   and installs the paired app and CLI. Do not rebuild a tested candidate just to install it.
   After activating a changed CLI, follow the installed agent-skill check below.
5. Confirm the required user checks. Keep test/build/install evidence in the task report, PR, and local update
   records. Update feature requirements and open limits, not their work history. Then commit locally.
   Ask for publication approval if it has not already been given.

Do not repeat certificate creation, Bitwarden backup setup, official-profile migration, userscript installation,
CLI command setup, or default-browser selection for normal updates. Preserve the existing personal profile.
Script source files stay shared; update an installed userscript only when its source actually changes.

## Installed agent skills

For upstream or CLI updates, find installed Ardia skills on this Mac with this zsh command.
It searches existing agent skill directories, follows shared symlinks, and includes hidden files:

```zsh
rg -l --hidden --no-ignore -L -i 'ardia(-personal)?' \
  ~/.agents/skills(N) ~/.claude/skills(N) ~/.codex/skills(N) \
  ~/.config/opencode/skills(N) ~/.cursor/skills(N) ~/.gemini/skills(N) -g SKILL.md
```

The personal build fetches the macOS CLI artifact pinned in `apps/browser/official-plugins.json`,
checks its SHA-256, and applies the isolation changes in `scripts/personal/prepare-cli.py`.
For each pin change, check the upstream launcher, profile and endpoint selection, Keychain service,
CLI state, helper installation paths, and bundled skill examples. A missing artifact or changed
isolation patch blocks activation. Keep the app and CLI paired through the signed build record.

Inspect project skill directories and the records under `~/Library/Application Support/Ardia Personal/CLI`.
Compare installed skills with the prepared personal bundle before activation. After activation, update
only the installed personal copies. Back up local changes and preserve them. Review companion changes
before using `skills refresh`, which can also update the Cua Driver skill.
Keep the skill name `ardia` and use `ardia-personal` in command examples and tool permissions.

## Fork CI

Require the `checks` summary from [CI](../.github/workflows/ci.yml) on PRs to `main`. Linux runners
parallelize browser unit tests, typechecks, and the macOS JavaScript bundle. The macOS runner tests
native packages. Build, sign, and install Ardia Personal locally.

Disable workflows in the fork with `gh workflow disable <file> -R simon-ami/ardia`. Keep the upstream
workflow files for clean merges. Disable the duplicate Checks workflow, Android, iOS, Linux, Windows,
and Windows engine inputs. The personal app runs on Mac, and some other jobs need upstream engine assets
the fork cannot fetch. Disable Deploy and release workflows because the fork ships locally. Disable CLA,
Linked issue, Vouch, and Vouch manage for the personal fork. Leave scheduled Caches off unless needed.
Check for new workflows after each upstream merge with `gh workflow list --all -R simon-ami/ardia`.

## GitHub and rollback

Prepare a fork integration PR for protected `main`. For a useful new product change, also prepare a focused
upstream contribution. Exclude personal tooling, branding, workflow files, and sync merges from upstream PRs.
Before publication, show the destination, scope, checks, and draft title and description. Ask once.
For the fork, include push, PR creation, and merge in one approval request.
If an upstream issue is required, include its draft in that approval. Fork issues are currently disabled.
Monitor checks through T3 when merging is pending. Do not call an update integrated until the PR is merged.
After merge, fast-forward local `main`; no rebuild is needed if program inputs are unchanged.

If a deployed update fails, stop and inspect. Do not silently downgrade a potentially migrated profile.
On Simon's request, stop the personal app, preserve the failed current state, and restore the app, profile,
preferences, and CLI reference from the same update snapshot. Restoring only an old executable is insufficient.
Snapshots and the original migration backup stay private and out of Git. Do not delete them automatically.

## Maintenance and update record

Preserve README fork notice `2286d63b`, PR CI workflow `84beb05f`, and the personal-build feature record.
Starting point after setup: fork `main` at `9d18a24e`.
The installed update targets `v0.2.47-nightly.9`, commit `c37a870640a8ce5c569322535f9fbf82fcaecaa0`.
The signed app uses Chromium `158.0.8127.36`, engine key `367b6b04ea642e1afcb73365abd2f895fba1c7be`.
The paired CLI and managed skill use upstream `0.4.0` through `ardia-personal`. All eight custom features remain active.
CLI checks passed for the personal config path, `windows`, `methods`, and installation.
The CLI update snapshot is `20261121-121454-e15e7d1e`.
Typechecks, 145 focused browser checks, and hidden candidate checks passed. The candidate exercised native unloading,
MRU selection, switcher closing and sleeping filtering, settings restoration, lazy startup, and the personal CLI socket.
The Linux host suite still records its upstream Picture in Picture consent TODO. The native plugin responsibility test
passed from scratch after macOS denied its disclaimed subprocess access to the checkout under Documents.
Installation snapshot: `20261120-233540-0fe4a2e4`. Evidence: `apps/browser/build-personal-signed/update-0.2.47-nightly.9/`.
Simon confirmed restored tabs, an existing login, Control-Tab previews, and Unload Tab with reload on selection.
