# Optional grayscale favicons for unloaded tabs

- Status: active; behavior and grouped settings manually validated.
- Source: Simon's request, inspired by [upstream PR #616](https://github.com/mantrakp04/ardia/pull/616);
  implemented in [fork PR #6](https://github.com/simon-ami/ardia/pull/6).
- Setting: Tabs → Unloaded tab appearance → Grayscale favicons
  (`grayscaleUnloadedFavicons`), synced, default off.
- Behavior: remove favicon color for sleeping/unloaded tabs; restore it on wake. Preserve custom icons and
  page previews. Keep title fading and icon fading independent. Group the three toggles under a standard
  section header with short labels, one shared description, and matching settings-search metadata.
- Code: `apps/browser/src/components/{sidebar/TabIcon.tsx,favicon/Favicon.tsx}`, settings rows, and native
  shell Surface. Native saturation uses Core Image; legacy React Native macOS ignores the standard filter
  style. Keep the web-demo Surface adapter compatible.
- Checks: `state/tabs/staleness.test.mjs`, settings search/conventions, and affected platform typechecks.
  Browser paths are relative to `apps/browser/src`.
- Manual: toggle a colorful favicon across sidebar, top strip, folder, split, and switcher; wake the tab.
  Check fading independence and settings search.

- Replacement: no equivalent in `v0.2.47-nightly.9`. Upstream strikethrough and icon fading do not remove
  favicon color. Keep the native filter and demo adapter; the new Linux adapter accepts the same CSS filter.
