# Title fading for unloaded and sleeping tabs

- Status: active. Simon confirmed the manual checks passed.
- Source: [fork PR #2](https://github.com/simon-ami/ardia/pull/2), `e44b9e8b`.
- Setting: Tabs → Unloaded tab appearance → Fade titles (`fadeUnloadedTabTitles`), default off.
- Behavior: fade titles for sleeping/unloaded pages, including closed pins and restored tabs awaiting load.
  Apply to sidebar, folder panel, top strip, and split tabs, including pinned tabs showing their current page.
  Restore opacity on load/wake; loaded background
  tabs stay opaque. Persist and sync the setting. Keep icon fading and grayscale independent.
- Code: `apps/browser/src/state/sidebar/rowState.ts` (`useFadeTabTitle`) and `state/settings/`.
- Checks: `apps/browser/src/state/tabs/staleness.test.mjs` and `state/session/sessionSettings.test.mjs`.
- Manual: toggle fading for loaded, sleeping, and unloaded tabs; wake a tab; vary icon fading separately.
- Related: [favicon grayscale](grayscale-unloaded-favicons.md).

- Replacement: upstream `v0.2.47-nightly.9` groups icon fading and strikethrough in one menu. Strikethrough uses strikethrough plus 60% opacity.
  The fork fades to 45% without strikethrough, independently of icon fading. Upstream includes unloaded
  pages only when their icon is faded; the fork includes them regardless. Simon chose to keep fade-only.
  When both options apply, use 45% once.
