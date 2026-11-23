# Boat CI overflow

GitHub-hosted runners run our CI. When they are busy, the long jobs of three workflows move to
[Boat CI](https://docs.boat.dev/ci.md) on `boat-large` (8 vCPU, 16 GB). Every other job stays on GitHub.

## What moves

| Workflow | Jobs that can move | GitHub runner otherwise | Median time on GitHub |
| - | - | - | - |
| `checks.yml` | `typecheck, tests and Mac bundle`, the 3 `browser tests` shares | `ubuntu-latest` | 2.2 min, 4.8 min |
| `linux.yml` | the 2 `checks` jobs, `package` | `ubuntu-24.04` | 2.5 and 4.0 min, 4.4 min |
| `android.yml` | `app` | `ubuntu-latest` | 5.2 min |

`repository, vouch and stale tests` takes about 40 seconds, so it stays on GitHub. So do the gates, `which checks run`,
the bots, vouch, CLA, linked-issue, stale, caches, deploy and identity jobs. Job names don't change.

## How a run decides

`scripts/ci/route-runner.mjs` runs once per run: in the `which checks run` job of `checks.yml`, and in a small
`route` job in `linux.yml` and `android.yml`. It is checked out from `main` (the pull request's base commit), never from
the pull request, together with `.github/TEAM.td`. It picks GitHub unless every step below says Boat:

1. **Kill switch.** The repo variable `BOAT_OVERFLOW` is `off`: GitHub. Unset or `auto`: carry on. `label`: only
   pull requests with the `boat-ci` label move (for a canary).
2. **Trust.** The run is in `ardia-browser/ardia` and is one of these:
   - a pull request from a branch of this repo (never a fork) into `main`;
   - a push to `main`, whose head commit author is on the team;
   - a manual run on `main`.

   Its author (for a pull request), `github.actor` and `github.triggering_actor` are all in `TEAM.td` from `main`.
   Vouch status and the `run-ci` label don't count.
3. **First attempt.** Any re-run goes to GitHub.
4. **`boat-ci` label.** A team pull request with the label skips the busy check below (Boat headroom still applies).
5. **GitHub is busy.** It reads queued and running runs in this repo and `ardia-browser/plugins` (at most 30 API
   calls, newest runs first), counting jobs on standard GitHub labels (`ubuntu-*`, `windows-*`, `macos-*`, not
   `-large` or `-xlarge`) and skipping its own run. It's busy when 3 or more Linux or Windows jobs are queued, 36 or
   more jobs are queued or running, or one Linux or Windows job has been queued for 20 seconds.
6. **Boat has room.** It reads the Boat account's `/limits` with the `BOAT_CI_LIMITS_KEY` secret. After the jobs this
   run would start (4 for Checks, 3 for Linux, 1 for Android), it needs at least 120 starts left today, 20 this hour,
   5 this minute, 50 included VM hours, 5 free sandboxes, `canStart`, and the `large` machine type.

Any error, timeout (5 seconds a request, 25 in all), bad answer or missing secret picks GitHub. Each run's summary has a
one-line table with the runner, the reason, how long it took and the counts it read; a `Runner` notice says the same.
That reason is how to watch it: `github-free`, `github-busy`, `forced-label`, `overflow-off`, `untrusted-*`, `rerun`,
`boat-low-*`, `boat-api-error`, `github-api-error`, `boat-key-missing`.

Each moved job asks for Boat only when the route job succeeded, said `boat`, and the run is on attempt 1. Otherwise it
uses its usual GitHub label. So a failed or skipped route job never stops a build; it only keeps it on GitHub.

### Settings

Repo variables, all optional:

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

Team only. It moves a pull request's long jobs to Boat on its **next** run, when Boat has room. The workflows don't run
on `labeled`, so add the label, then push (or close and reopen the pull request). A re-run does not count: it goes to
GitHub.

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

Rotate it when someone outside the team gets write access, when it leaks, and before it expires (the current key
expires 2027-02-20):

```bash
boat api-key rotate <key id>
gh secret set BOAT_CI_LIMITS_KEY -R ardia-browser/ardia
```

## Code

- `scripts/ci/route-runner.mjs` and its tests, `scripts/ci/route-runner.test.mjs` (run by `node --run test:root`).
- The route steps and `runs-on` lines in `.github/workflows/checks.yml`, `linux.yml` and `android.yml`.
- On a Boat runner, `android.yml` sets up the Android SDK (`android-actions/setup-android`) and `linux.yml` installs a
  stock Chrome for the acceptance self-test (`browser-actions/setup-chrome`); GitHub's image already has both.
- `.github/vouch/vouch.cjs` ignores a skipped `route` job when it looks for a fork build the gate held back.
