# Store simulator

`apps/browser/scripts/sim/` runs the real browser store (`useBrowser`, with its persistence and the pinned-area sync
adapters) under plain node, on the same native fakes the store tests use, and drives it with seeded random sequences of
real actions. After every step it checks a set of rules; a failing sequence shrinks to the shortest one that still fails
the same rule, and prints it with a replay line.

```
pnpm -C apps/browser sim                                    the CI seed set: correctness, cost, leak, dependency map
node apps/browser/scripts/sim/run.mjs --mode correctness --soak 60      keep drawing seeds for a minute
node apps/browser/scripts/sim/run.mjs --replay '[["shareTabs",0], …]'   replay one printed sequence step by step
node apps/browser/scripts/sim/run.mjs --src <dir>/apps/browser/src      drive an older commit's export (git archive)
```

The CI seed set is deterministic: the clock is fake, `Math.random` is seeded, timers of 20 ms or more never fire and
shorter ones run in order at the simulator's own turns, so the same tree prints the same output byte for byte.

## Actions

Open a tab (in the window's profile or another), close, select, move within a window and to another window, pin and
unpin (tile or row), group (pinned folder or plain group), ungroup, add to and take out of a group, new window, close
window, switch profile, create and delete a profile, share tabs across windows on or off, sleep, reopen a closed tab or
window, a sync patch (a second device pins or reorders, both devices sync, this one syncs twice), save then reload the
session, quit then relaunch. Each step carries four random picks that choose its targets from the live state, so a
shrunk sequence still means something after steps around it are removed.

## Rules

| Rule | Fails when |
| --- | --- |
| `pins` | a pin key of a profile (in a window, a pinned folder or parked) disappears in a step that didn't unpin it, take it out of a pinned folder, or delete its profile; pinning a tab leaves no pinned copy of it; unpinning or regrouping closes the tab and every copy of its page |
| `structure` | a tab isn't listed by exactly the window it names, an id in a window, group, selection, split or order list doesn't resolve, or a window's remembered active tab for a profile is missing or lives elsewhere |
| `session`, `relaunch` | save then reload, or quit then relaunch, changes the windows, tabs, pins and their placement, groups, parked pins, the recently closed lists or the sharing setting (both sides are copied before the save; tab order is compared within its section, the order `hydrate` restores, because the live store doesn't keep sections in order) |
| `sync` | the second sync with nothing new changes the pinned area, its folders, parked pins or each window's pin order |
| `reopen` | reopening leaves the entry it should restore on the list, or takes an entry off without opening or showing its pages |
| `errors` | anything is logged with `console.error` during a step (a settle that doesn't converge is logged, not thrown, outside tests) |
| reach | a CI run never reaches one of the actions, or one of the states the rules depend on (a sync that brought a change, a reload or relaunch holding pins, a window closed holding pins, a shared window closed into another, a reopen that restored something, a pin the person removed) |

## Known failures and regressions

`scripts/sim/known.json` holds shrunk sequences by issue. Those under `failing` reproduce a bug that is open today
and must still fail their rule; once a fix lands they pass and the run fails until the entry moves to `holding`, where
it must pass from then on. The CI run checks both lists.

## Cost

`--mode cost` starts the services `main.tsx` starts (those that run in node), mounts every store hook the per-row
components import (`PER_ROW_FILES` in `rowHooks.mjs`) once per tab through a small hook runner, and changes one tab at a
time: its title, its page state, its screen share. A hook whose instances for other tabs are notified is subscribed more
widely than its row. Title and page-state changes are hot paths and are budgeted: a hook that wakes other rows on one
fails unless `scripts/sim/baseline.json` lists it, and a listed hook that no longer wakes them fails until it is taken
out, so the list only shrinks. Screen-share changes are rare and only reported.

It also prints, per action kind, the service listener calls (plain and keyed), the keyed-watch hears, and the per-row
hook wakes, split into those for rows of tabs the action touched and those it didn't.

## Leak

`--mode leak` runs open, select, move, pin, unpin, group, ungroup, new window, move across, close window and close
tabs cycles that end in the starting shape, with the rows mounted while the tabs are open and unmounted when they
close, and fails if store listeners, row subscriptions, pending timers, any store record or the number of nested objects
in the store's data grew, if a bounded list (`closedTabs`, …) is still
growing at the end, or if the heap after a forced GC grew more than 4 MB.

## Dependency map

`--mode map` writes `apps/browser/sim-out/dependency-map.md`: every listener on the browser store, by the top-level key
it is keyed on or reads when it runs, with its registration site and owner, the plain listeners that read three keys or
fewer (candidates for `subscribeTo`), and the per-row hooks with the ones that subscribe to the whole store. Listeners
registered while the store loads (its session persistence and live-tab bookkeeping) come before the probe and are not in
it, and map mode hands listeners proxies of the state, so it is a report, not a check.

## What it does not replace

It can stand in for hand-written store sequence tests and for the store-cost part of the perf ratchet's exact counts.
It does not replace anything native, the timing gate, mount and render counts on a real build, looks checked from
pixels, the Linux and Windows adapters, or the conventions checks. It sees the store and the hooks it mounts; a
subscription a component makes itself, outside a hook from `state/`, is invisible to it.
