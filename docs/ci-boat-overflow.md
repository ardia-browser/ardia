# Boat CI overflow

GitHub-hosted runners run our CI. When they are busy, the long jobs of three workflows move to
[Boat CI](https://docs.boat.dev/ci.md) on `boat-large` (8 vCPU, 16 GB). Every other job stays on GitHub.

## What moves

| Workflow | Jobs that can move | GitHub runner otherwise | Median time on GitHub |
| - | - | - | - |
| `checks.yml` | `typecheck, tests and Mac bundle`, the 6 `browser tests` shares | `ubuntu-latest` | 2.2 min, 4.8 min (with 3 shares) |
| `linux.yml` | the 2 `checks` jobs, `package` | `ubuntu-24.04` | 2.5 and 4.0 min, 4.4 min |
| `android.yml` | `app` | `ubuntu-latest` | 5.2 min |

`repository, vouch and stale tests` takes about 40 seconds, so it stays on GitHub. So do the gates, `which checks run`,
the bots, vouch, CLA, linked-issue, stale, caches, deploy and identity jobs. Job names don't change.

## How a run decides

`scripts/ci/route-runner.mjs` runs once per run: in the `which checks run` job of `checks.yml`, and in a small
`route` job in `linux.yml` and `android.yml`. It and `.github/TEAM.td` are always checked out from `refs/heads/main`,
never from the pull request or its base branch, so the step that holds the key runs only main's code. It picks GitHub
unless every step below says Boat:

1. **Kill switch.** The repo variable `BOAT_OVERFLOW` is `off`: GitHub. Unset or `auto`: carry on. `label`: only
   pull requests with the `boat-ci` label move (for a canary).
2. **Trust.** The run is in `ardia-browser/ardia` and is one of these:
   - a pull request from a branch of this repo (never a fork) into `main` (checked case-sensitively);
   - a push to `main`, whose head commit author is on the team;
   - a manual run on `main`.

   Its author (for a pull request), `github.actor` and `github.triggering_actor` are all in `TEAM.td` from `main`.
   Vouch status and the `run-ci` label don't count.
3. **First attempt.** Any re-run goes to GitHub.
4. **`boat-ci` label.** A team pull request with the label skips the busy check below (Boat headroom still applies).
5. **GitHub is busy.** It reads queued and running runs in this repo and `ardia-browser/plugins`, then their jobs,
   newest runs first: the newest four first, and the rest of its budget at once only when those four don't already
   make GitHub busy (more jobs can only add to the counts), so a busy GitHub costs a few calls, not the whole budget. It
   makes at most 30 API calls: up to 10 for run lists, the rest for job lists, page by page. These calls use the
   repo's `GITHUB_TOKEN`, whose 1,000 requests an hour every workflow shares, `cla` and `identity` included. It
   skips its own run and counts only jobs on a fixed list of GitHub-hosted labels: `ubuntu-latest`, `-24.04`,
   `-22.04` and their `-arm` twins, `windows-latest`, `-2025`, `-2022`, `-11-arm`, `macos-latest`, `-26`, `-15`, `-14`,
   their `-intel` twins, `macos-13` and `xcode-27`. A test fails if a workflow uses a hosted label that isn't on it.
   GitHub is busy when 3 or more Linux or Windows jobs are queued, 36 or more jobs are queued or running, or one
   Linux or Windows job has been queued for 20 seconds. macOS and `xcode-*` jobs count only toward the 36, because
   they queue on their own cap. If any read fails or comes back malformed, it picks GitHub (`github-read-failed`)
   rather than deciding from part of the picture.
6. **Boat has room.** It reads the Boat account's `/limits` with the `BOAT_CI_LIMITS_KEY` secret. After the jobs this
   run would start (7 for Checks, 3 for Linux, 1 for Android), it needs at least 120 starts left today, 20 this hour,
   5 this minute, 50 included VM hours, 5 free sandboxes, `canStart`, and the `large` machine type.

Any error, timeout or missing secret picks GitHub. Each request has 5 seconds. After 25 seconds in all, the router
aborts what is still running and picks GitHub. Each run's summary has a one-line table with the runner, the reason, how
long it took and the counts it read; a `Runner` notice says the same. It shows only numbers that passed validation and
the reason, never a raw response. That reason is how to watch it: `github-free`, `github-busy`, `forced-label`,
`overflow-off`, `untrusted-*`, `rerun`, `boat-low-*`, `boat-limits-malformed`, `boat-api-error`,
`github-read-failed`, `boat-key-missing`, `router-timeout`, `router-error`.

A last step of the route job always runs. It sets the job's `target` output to `boat` only when the router step
succeeded and said `boat`, and to `github` otherwise. Each moved job asks for Boat only when the route job succeeded,
its `target` is `boat`, and the run is on attempt 1. Otherwise it uses its usual GitHub label. So a failed or skipped
route job never stops a build; it only keeps it on GitHub.

### Settings

Repo variables, all optional. Each workflow passes these by name to the router step, and nothing else from `vars`:

| Variable | Default | Meaning |
| - | - | - |
| `BOAT_OVERFLOW` | `auto` | `off`, `auto` or `label` |
| `BOAT_OVERFLOW_REPOS` | `ardia-browser/ardia,ardia-browser/plugins` | Repos whose runs count toward GitHub's load |
| `BOAT_OVERFLOW_QUEUED` | `3` | Queued Linux and Windows jobs that make GitHub busy |
| `BOAT_OVERFLOW_BUSY` | `36` | Queued plus running jobs that make GitHub busy |
| `BOAT_OVERFLOW_QUEUED_AGE` | `20` | Seconds one job may wait before GitHub counts as busy; `0` turns it off |
| `BOAT_OVERFLOW_DAY_STARTS`, `_HOUR_STARTS`, `_MINUTE_STARTS` | `120`, `20`, `5` | Boat starts to keep in reserve |
| `BOAT_OVERFLOW_VM_HOURS` | `50` | Included VM hours to keep in reserve |
| `BOAT_OVERFLOW_SANDBOXES` | `5` | Free sandboxes to keep in reserve |

## The `boat-ci` label

Team only. It moves a pull request's long jobs to Boat, when Boat has room, from the next `pull_request` run on: the
next push to the branch, or closing and reopening the pull request. Adding the label starts nothing, because the
workflows don't run on `labeled`. A re-run doesn't count: it is attempt 2 and goes to GitHub.

## When Boat pauses a job

Past the plan's start limit, Boat doesn't charge extra (extra starts are set to `fail`). Instead the job shows **Paused
by plan limit** on GitHub. It never restarts by itself. Re-run it: **Re-run failed jobs** or **Re-run all jobs** both
work, because a re-run is attempt 2 and every moved job then picks GitHub.

## Seeing the jobs

```bash
boat ci                                      # setup, problems, last jobs
boat ci --repo ardia-browser/ardia --state failed
boat ci job <job id>
boat ci logs <job id> --follow
```

## Accounts

The Boat CI GitHub app on `ardia-browser` bills Boat account #2. Account #1 is kept for interactive and Chromium
builder VMs; CI never uses it unless someone fails over by hand. Account #2 allows public-repo runs for `mantrakp04` and
`shivamhwp` only, and refuses anyone else's runs even if they reach it.

### Failing over to account #1

Only when account #2 can't run CI any more. The owner does it:

1. In a browser-backed `boat login`, sign in to account #1.
2. `boat ci connect --account ardia-browser`, and confirm the link.
3. `boat ci public ardia-browser on --users "mantrakp04, shivamhwp"`
4. `boat billing extra-starts fail`
5. Make a read-only (`account.read`) API key on account #1 and replace the secret:
   `gh secret set BOAT_CI_LIMITS_KEY -R ardia-browser/ardia`. A key made from an API-key session lasts 89 days at most.

To stop overflow at once, set `BOAT_OVERFLOW` to `off`.

## The key and its risk

`BOAT_CI_LIMITS_KEY` is read-only. It can read the account's plan, limits and CI job list. It can't start sandboxes,
change settings or spend money. Only the route step gets it.

Anyone with write access to this repo can edit workflow YAML on a branch and read any repo secret, this one too. Four
people outside the team have write access. That is why the key is read-only: in their hands it shows the Boat
account's plan, limits and CI jobs, and nothing else. Boat's own allow list still refuses to run their jobs.

Replace it when someone outside the team gets write access, when it leaks, and before it expires. The current key
expires 2027-02-20. `boat api-key rotate` keeps the old expiry, so it can't renew the key. Make a new one instead:

1. In a browser-backed `boat login` on the account the CI app bills (a browser session allows a longer TTL than an
   API-key session's 89 days), create a read-only key:
   `boat api-key create ci-limits --preset read-only --ttl <days>d`
2. `gh secret set BOAT_CI_LIMITS_KEY -R ardia-browser/ardia` and paste the new key.
3. Prove the new key works before you revoke the old one: add `boat-ci` to a team PR and push. The route step's summary
   must show a `Boat: starts left …` line with numbers, and a reason of `forced-label` or `boat-low-…`. `boat-api-error`,
   `boat-key-missing`, `github-free` or `overflow-off` prove nothing. Then revoke the old key with
   `boat api-key revoke <old key id>`.

## Code

- `scripts/ci/route-runner.mjs` and its tests, `scripts/ci/route-runner.test.mjs` (run by `node --run test:root`).
- The route steps and `runs-on` lines in `.github/workflows/checks.yml`, `linux.yml` and `android.yml`.
- On a Boat runner, `android.yml` sets up the Android SDK (`android-actions/setup-android`) and `linux.yml` installs a
  stock Chrome for the acceptance self-test (`browser-actions/setup-chrome`); GitHub's image already has both.
- `.github/vouch/vouch.cjs` ignores a skipped `route` job when it looks for a fork build the gate held back.
