# Native manual tab unloading and discard recovery

- Status: native command manually validated; Auto Tab Discard remains unresolved.
- Source: [fork PR #6](https://github.com/simon-ami/ardia/pull/6) and
  [upstream issue #634](https://github.com/mantrakp04/ardia/issues/634).
- Behavior: provide Unload Tab, Unload N Tabs, and configurable Unload Tab(s) in keyboard shortcuts/app menu,
  with no default binding. Use native WebView discard; retain tab identity, rows, and navigation history.
  Report native refusals.
- Before unloading, select an awake same-window, same-space MRU page, excluding all targets. Open a new tab
  if none exists; never remove targets or close the window. See [successor selection](cross-section-close-mru.md).
- Apply recovery to extension discards only when their native event reaches the app. Background discards
  do not change selection; ignore replacements in a different shared-data space.
- Code: `apps/browser/src/state/tabs/discardActions.ts`, `components/window/TabWebView.tsx`, command catalog,
  tab menus, and generated native command tables.
- Checks: `state/tabs/discardActions.test.mjs` and close/menu cases under `apps/browser/src`.
- Manual: unload one/multiple tabs; check replacement, retained rows, wake, Back history, and a bound shortcut.
- Open: #634 is not proven fixed for the real extension path. Further extension debugging is deferred.

- Replacement: `v0.2.47-nightly.5` has no general manual-sleep menu or configurable unload shortcut.
  Unreleased upstream `208ff58972d216409ba3122cb192549324523c6f` adds Sleep Tab/Tabs for hidden Chromium pages and nested groups with proactive protections. It cannot unload the shown tab
  and offers no matching shortcut. The fork switches first and uses native discard. Keep the command.
  Upstream `489dcb22da49ddf5af018777d4aeaa592a24c1d2`, also unreleased, follows an extension's
  activation into another shared-data space; the fork deliberately keeps recovery in the current space.
