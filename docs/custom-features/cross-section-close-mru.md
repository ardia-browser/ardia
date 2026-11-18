# MRU successor across pinned and regular tabs

- Status: active; adapted upstream behavior passed automated and manual checks.
- Source: [fork PR #6](https://github.com/simon-ami/ardia/pull/6).
- Behavior: closing or unloading the active tab selects the most recent awake, non-empty page in the same
  window and space, across regular tabs, pins, pinned groups, and Top Apps. Exclude every affected tab.
  MRU takes precedence over opener/sibling preference when an awake candidate exists.
- Keep upstream's remaining split pane visible after a pane closes. Background links count as used only
  after selection; prefer visited pages over unseen links.
- Preserve pinned-tab unloading versus regular-tab removal, existing no-candidate/window-close fallbacks,
  and selection when closing a background tab. Record activation of the selected successor.
- Code: `apps/browser/src/state/tabs/{awakeMru.ts,tabs.ts}`.
- Checks: `closing.test.mjs`, `tabs.test.mjs`, and `discardActions.test.mjs` in that folder.
  Recency tests need distinct activation timestamps.
- Manual: alternate visits between a regular tab and a pin/Top App, then close the newest tab in both
  directions. The newest awake same-space page wins; sleeping pages do not.
- Related: [native unloading](manual-tab-unloading.md).
- Replacement: upstream `v0.2.47-nightly.5` adds MRU close selection. The fork keeps its close/activation flow
  and split behavior, with the missing awake-page eligibility and cross-section pinned successor rule.
