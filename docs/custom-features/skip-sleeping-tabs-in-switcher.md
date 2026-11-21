# Exclude sleeping tabs from the MRU switcher

- Status: active; native unloading and adapted upstream behavior passed automated and manual checks.
  Chrome automatic discard is not separately verified.
- Source: [upstream PR #612](https://github.com/mantrakp04/ardia/pull/612), `posthog-eu[bot]`,
  head `5c28393aceff9f08c9a1ca3713bdbe0d720b0b88`.
- Setting: Tabs → Show sleeping tabs in the tab switcher (`sleepingTabsInSwitcher`), synced, default on.
- Behavior: when off, exclude sleeping/unloaded tabs but retain the active tab. Filter before sorting and
  the two-tab recency allowance, so older awake tabs remain reachable. Apply to session selection and the
  [preview switcher](preview-tab-switcher.md) fallback. Preserve cards and selection styling.
- Code: `apps/browser/src/state/pins/tabCleanup.ts`, settings registry, Tabs pane, and settings search rows.
- Checks: `state/pins/recentTabs.test.mjs`, `state/sidebar/sessionTabs.test.mjs`, settings/session defaults,
  and settings search under `apps/browser/src`.
- Manual: unload a tab; toggle the setting and check its card disappears/returns. Check selection and persistence
  after restart. The separate [Auto Tab Discard limitation](manual-tab-unloading.md) remains open.
- Replacement: upstream `v0.2.47-nightly.9` always hides sleeping pages. The fork uses its ordering and live
  updates with one shared eligibility check that retains this toggle, including selection on release.
