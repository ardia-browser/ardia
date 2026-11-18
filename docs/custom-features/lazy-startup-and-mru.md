# Lazy startup and MRU page eligibility

- Status: active; manual improvement reported, Chrome-page omission still unresolved.
- Source: [fork PR #6](https://github.com/simon-ami/ardia/pull/6).
- Behavior: empty command-bar tabs and `about:blank` never enter MRU. Control-Tab does nothing with one
  eligible page. From an excluded empty tab with two eligible pages, the first step picks the newest page.
- Startup must not schedule background page warmup. Restore the selected page and wake tabs on selection
  as before. Keep the explicit warmup helper available for diagnostics.
- Code: `apps/browser/src/state/pins/tabCleanup.ts`, `state/sidebar/switcher.ts`, and
  `state/tabs/tabLifecycle.ts`. The removed startup schedule was deliberate warmup, not a proven race.
- Checks: `state/pins/recentTabs.test.mjs`, `state/sidebar/sessionTabs.test.mjs`, and
  `state/tabs/tabLifecycle.test.mjs`; browser paths are relative to `apps/browser/src`.
- Manual: unload all pages, wake one, and check that MRU excludes the empty replacement. Restart with several
  visited tabs; wait at least 15 seconds. Unvisited background pages must stay idle.
- Open: intermittent omission of the Chrome extensions-shortcuts page. Existing checks found it eligible;
  no Chrome-specific fix is established. Recheck after visiting other pages and unload/wake.

- Replacement: `v0.2.47-nightly.5` still schedules recent-tab warmup three seconds after system-state load
  and permits empty pages in MRU. Keep both adaptations. The loaded-tab budget sleeps background tabs;
  it does not replace lazy startup.
