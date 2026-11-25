# CI's GitHub API budget

Every workflow here calls the API with the repo's `GITHUB_TOKEN`, an installation token of the GitHub Actions app.
Every workflow in the repo shares its budget of 1,000 REST requests an hour, plus a separate GraphQL points budget.
No workflow uses a GitHub App token of its own. When the budget runs out, every bot fails with
"API rate limit exceeded for installation": `cla`, `identity`, the gates, vouch.

## What one pull request run costs

| Check | Event | REST | GraphQL |
| - | - | - | - |
| `cla` (`.github/cla/cla.cjs`) | opened, synchronize, reopened | 0, or 1 when its comment must change | 1 (more only past 100 commits or comments) |
| `cla` | a signing comment | 4: the comment, the signature, the run lookup, the re-run | 1 |
| `cla` | `recheck` | 1, plus 1 when it re-runs a failed check | 1 |
| `cla` | merged | 1 (lock) | 0 |
| `identity` (`windows.yml`) | pull_request | 0; 1 on a re-run | 0 |
| `gate` (6 workflows, forks only) | pull_request | 0 for a trusted or denounced author; 1 for an unvouched one, whose `run-ci` label is read live; 1–2 on a re-run | 0 |
| `vouch` | synchronize, edited, ready_for_review, converted_to_draft by the team or a bot | 0 | 0 |
| `vouch` | the same by anyone else | 1 page of open pull requests, plus writes that change something | 1, plus up to 3 while `mergeable` is unknown |
| `linked-issue` | opened, edited, reopened | 1, plus 1 per closing reference on a non-default base | 0 |
| `stale` | anything on a pull request not labelled `stale` | 0 | 0 |

## Keeping it low
- Read what the event already holds (`github.event.pull_request`: labels, author, association) before calling the API.
  Read live on a re-run (`GITHUB_RUN_ATTEMPT` > 1), where labels may have changed since the event, and before
  anything a label decides, such as `run-ci` on an unvouched author's pull request, which a maintainer may have added
  or taken off while the run waited in the queue.
- Decide who the author is (`TEAM.td`, a bot) before any read, and stop there when the rules don't apply to them.
- Ask GraphQL for everything at once: `cla` reads the commits, the comments, the head and the signature file
  (`object(expression: "cla-signatures:signatures/cla-v1.json")`) in one query.
- Write only what changes: compare the bot's comment, labels and statuses before writing them.
- Never skip a required check's job to save calls: a skipped job counts as passed. Return early inside the step.
- Every script runs from the default branch (`sparse-checkout: .github`, `persist-credentials: false`), never
  from the pull request, so a pull request can't change its own checks or the lists they trust.
- Each script's tests (`.github/*/*.test.cjs`) pin its calls with a stub that
  records every request.
