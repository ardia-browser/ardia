# MRU tab switcher with page previews

- Status: active; updated appearance needs manual validation.
- Source: [upstream PR #186](https://github.com/mantrakp04/ardia/pull/186), Nana Amoako (`nanadotam`), head `6cc0afcd5e0b0c73b4eb7bb45a4f4cab98f16e28`. Base: `v0.2.47-nightly.5`,
  `f6636c47bd20ac2c86d82f5b54898498594b0512`.
- Behavior: Control-Tab opens after 140 ms; Control-Shift-Tab reverses; release commits; Escape cancels;
  mouse selects. Scope: current window/profile. Prefer session tabs; fall back when fewer than two qualify.
- Zen 1.24.1b layout: picture width `ceil(logical screen width × 0.85 / 7)`; height follows screen aspect.
  Clamp to the window; keep selection visible. Column spacing is 1.25 × picture width.
  Use 13 pt regular centered titles with an 8 pt gap; 8 pt card padding and a constant 2 pt selection border.
- No white backing, inactive outline or selection inset.
  Favicon badge: 42 pt outer size, 5 pt padding, 1 pt border, 30 pt icon, 6 pt bottom/right overlap.
  Keep opaque badges and light-theme icon contrast.
- Cache 40 previews; exclude private tabs. Refresh on picture arrival;
  reject captures after closing, navigation, profile, or WebView changes. Track screen changes.
- Use upstream interaction, subscriptions, and live eligibility with personal filtering.
- Code: `components/sidebar/{TabSwitcher.tsx,tokens.ts}`, `state/sidebar/switcher.ts`, `state/pins/tabCleanup.ts`,
  and `state/tabs/tabPictures.ts`, relative to `apps/browser/src`.
- Checks: `sessionTabs.test.mjs`, `tabPictures.test.mjs`, adjacent `pinHandoff.test.mjs`, and conventions.
- Manual: cycle/commit/cancel/mouse, narrow windows, themes, private tabs, custom icons.

- Replacement: upstream still uses fixed 168-point cards, smaller favicon placement, white page backing
  and an inactive ring; capture guards still check only tab existence. Keep the personal layout and guards.
  Use upstream's new close-highlighted/hovered action and keep the overlay open down to one card.
