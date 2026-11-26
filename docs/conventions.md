# Conventions

How Ardia's code is laid out and written. `apps/browser/src/conventions.test.mjs` enforces most of it (see
[The check](#the-check)); the rest is on review.

## Backwards compatibility: migrations only

The app and its engine ship together (a release bundles its engine; a dev build fetches the prebuilt engine matching
its commit's engine key for its platform, `engine/engine-key.sh --platform macos|linux`), so code never tolerates a
mismatched engine.

- No `respondsToSelector` guards for ArdiaCore's API, no optional `?.()` native calls, no always-true `isAvailable`
  checks, no metadata probes, no aliases for old names, no duplicate overloads. Keep `respondsToSelector` only for
  private AppKit or Chromium classes looked up at runtime.
- What stays: versioned on-disk data migrations (Netnyahoo → Ardia included), the versioned sync payload (a nightly Mac
  syncs with a stable Mac a version behind), and the one app/engine version assertion: `NATIVE_API_VERSION` and
  `apiVersion` in `packages/shell/ios/AppModule.swift`. Bump both when the native surface changes.

## Folders and import direction (`apps/browser/src`)

```
App.tsx, main.tsx       entry points
components/ui/          design system: pieces, tokens, motion, wrapped native views
components/<feature>/   sidebar, tabstrip, omnibox, downloads, settings, import, onboarding, …
state/<domain>/         tabs, windows, profiles, bookmarks, history, downloads, settings, engines, extensions, sync, …
platform/               the only code that calls native modules
lib/                    pure helpers: url, color, time, keys
```

| From | May import |
| --- | --- |
| `components/<feature>` | `components/*`, `state`, `lib` |
| `components/ui` | `components/ui`, `lib` |
| `state` | `state`, `platform`, `lib` |
| `platform` | `platform`, `lib` |
| `lib` | `lib` (nothing else in the app) |

- Only `platform/` imports native packages (`@ardia/ardiacore`, `@ardia/shell`, `@ardia/shaders`, `@ardia/import`,
  `@ardia/sync`), `expo-modules-core` or `NativeModules`. `components/ui/` may import native *views* to wrap them.
- `platform/<domain>.ts` holds one domain's native functions and types (`platform/downloads.ts`, `platform/menus.ts`,
  `platform/windows.ts`, …). It binds each one itself, against the typed `call()`/`on()` of `@ardia/ardiacore` or a
  package's typed `nativeModule(…)`, so a call returns and throws exactly what the native API does; the packages keep
  the types and only the wrappers that add something (a secret call, a mapping, a view). A name lives in one platform
  module.
- Components never call native functions; they call actions in `state/`. Where the action is the native call itself,
  the domain re-exports it: `state/app/system.ts` (menus, alerts, prompts, the clipboard, haptics, files, external
  URLs), `state/app/appSettings.ts`, `state/windows/nativeWindow.ts`, `state/downloads/actions.ts`, … Native views
  come from `components/ui`.
- Components never import `platform/`. A platform value a component uses (a web view handle, a kill switch, the
  import module) reaches it as a re-export from its domain in `state/`: `state/tabs/webviewHandles.ts`,
  `state/app/switches.ts`, `state/app/slowTimers.ts`, `state/app/nativeApiSkew.ts`,
  `state/import/importApi.ts`, and `isWebDemo` from `state/onboarding/demoSteps.ts`. Each re-export file imports
  only its platform module, so modules still load in the same order.
- The one exception is the dev harness (`components/dev/devHarness.ts`): it hands the whole shell module to CDP
  scripts as `ac.shell` (`platform/devShell.ts`), with the documents, engine, web view and preload modules beside it.
  The check exempts that file by name (`HANDS_PLATFORM_TO_SCRIPTS`), not the `components/dev/` folder.
- Nothing lives outside these folders except the entry points.

## UI

- **Values come from tokens.** `components/ui/tokens.ts` holds the colour roles (light and dark), spacing scale,
  radii, type, shadow levels; `components/ui/motion.ts` holds the motion presets (named curves and the one spring
  converter). A Dia-measured value used in one place is a named constant in its feature's `tokens.ts`.
- **One role per look.** Before adding a colour or shadow, use the role that already draws it; a feature palette
  points at a shared role (`colorRoles.dark.destructive`) instead of copying its value. User-picked colours (profile
  and tab group palettes) are data, not roles. The shared roles that replaced lookalikes (2026-10-26):

  | Role | Dark / light | For |
  | --- | --- | --- |
  | `accent` | #4A77D4 / #6395FC (Dia's CommandBar blue) | chrome and popovers: drop rings, progress, links, popover toggles and checkmarks, live unread dots |
  | `formAccent` | #0A84FF / #007AFF (system blue) | AppKit-style controls in settings, dialogs and pages: primary buttons, checkboxes, radios, form switches, selection |
  | `destructive` | #FF453A / #FF3B30 | every danger, error, failing and recording red |
  | `warning`, `success` | #FF9F0A / #FF9500, #30D158 / #34C759 | amber notices and conflicts; done, passing, default |
  | `rowHover` | white / black 0.07 (Dia's Menu/ItemBackgroundHovered) | every row hover: sidebar, menus, popovers, settings, pages |
  | `divider` | white / black 0.09 (Dia's Primitives/Primary1200) | every separator line; the top strip's group divider and the site-coloured toolbar keep their own |
  | `panel` | #2A2A2A / #FFFFFF (Dia's command panel) | opaque panels, dialogs, cards, the media players |
  | `tooltipFill` | #262626 / #FFFFFF (Dia's tooltip) | tooltips; `popoverFill` and `popoverTint` are its colour at the menu material's alphas |
  | `onPrimary` | #000000 / #FFFFFF | ink on a filled pill or badge (Go, chip primary, onboarding primary, badges) |
  | `shadow.dialog` | 24 pt, (0, 10) | dialogs, sheets, the command panel, NTP cards (with their own opacity); `shadow.popover` (18, (0, 8)) is the lighter menu-material level |
- No hex, `rgb()`/`rgba()`/`hsl()` literals, `Easing.` curves or numeric animation durations outside files named
  `tokens.ts` or `motion.ts`.
- **Motion by frequency of use.** High-frequency controls (tab rows, tiles, folders, toolbar buttons, menus, the
  command bar) get no bounce, squish or overshoot: state changes land on the press, and any curve is short and
  critically damped. Springs with visible overshoot (`springs.bouncy`) are for rare, larger moves such as the
  sidebar opening, onboarding and sheets (AGENTS.md, Building features). The one exception is opt-in and off by
  default: `config.json`'s `pressMotion: "bounce"` (no Settings row, `docs/config.md`) brings back 0.2.47-nightly.6's
  squish through `useSquish`, `usePressScaleMotion` and `liftSpring`, never through `springs.bouncy` at the call site.
- **Screens are built from `components/ui/` pieces:** Box, Text, Button (icon, text, pill and close variants),
  Popover, Dialog, Row, Field, Switch, Radio, Menu, with token props (`pad="m" fill="panel" radius="l"`). Native views
  (Surface, Symbol, the web view, …) are wrapped there too. Feature code passes `style` only for layout (flex,
  position, size) and animated values.
- One copy of each piece. Before writing a button, panel, closing animation, colour maths or a URL helper, use the
  one in `components/ui/`, `lib/` (`lib/url.ts`, `lib/color.ts`) or `@ardia/core` (`hostOf`).
- Import pieces from the `components/ui` index (`import { Button, Popover } from "../ui"`). Inside `components/ui`,
  modules import each other directly.

### Which piece replaces what

| Hand-built today | Use |
| --- | --- |
| `theme.dark ? "rgba(…)" : "rgba(…)"` | a role on the theme (`theme.popoverBorder`, `theme.scrim`, …), added to both palettes in `tokens.ts` |
| `useFormColors().accent` and friends | the theme role: `formAccent`, `groupFill`, `control`, `field`, `destructive`, `searchFlash`, … |
| `Easing.out(Easing.quad)`, `Easing.bezier(…)` | `curve.enter`, `curve.exit`, `curve.move`, `curve.pulse`, … from `motion.ts` |
| a numeric `duration:` | `duration.fast`, `duration.base`, `duration.slow`, `duration.long`; a loop's period is `period.spinner` / `period.pulse` |
| `stiffness: (2π/response)²` written by hand | `springs.snappy` / `smooth`, or `spring({ response, damping })` for a measured spring; `springs.bouncy` only for a rare, larger move (a badge appearing, the sidebar's edge springing back from a resize past its limit) |
| a glyph or a small control that dips while pressed | `usePressScaleMotion(enabled, buttonMotion.…)` on its `onPressIn`/`onPressOut`: `springs.snappy` both ways, no bounce. Rows, folder headers and tiles don't scale at all, unless `pressMotion` is `"bounce"`: then `useSquish("row" \| "tile")` and `<Squish scale>` from `ui/Squish.tsx` (Motion by frequency of use; `ui/pressFeedback.test.mjs` keeps `springs.bouncy` out of the sidebar, the tab strip, the toolbar, the command bar, the New Tab page and the shared buttons, rows and menus) |
| a hover or pressed highlight behind a row or a button plate | `<HoverFill shown color radius>`: lights in `hoverFade.show`, fades in `hoverFade.hide`; `instant` when the thing becomes selected. Over a fill it has at rest: `<HoverSwap rest color radius>`, with `underBorder` when the control draws a border |
| a `View` with `padding`/`gap`/`backgroundColor`/`borderRadius` from tokens | `<Box pad="m" gap="s" fill="panel" radius="tile" row>` |
| `<Text style={{ fontSize: 13, fontWeight: "600", color: theme.textSecondary }}>` | `<Text size="body" weight="semibold" tone="textSecondary">` |
| a pressable square with an SF Symbol and a hover plate | `<Button variant="icon" icon="…">` (add `toolbar` for toolbar buttons: modifier clicks, long press, context menu, no window drag; `palette` for site-coloured toolbars) |
| a hover-plated text link ("Replace", "Clear", "Skip Tour") | `<Button variant="text" title plate="toolbar" \| "hover" \| "none">` |
| a filled rounded button with a title | `<Button variant="pill" tone="prompt" \| "chip" primary>`; a bordered +/− control is `<Button variant="stepper" icon width height tooltip>` |
| a dismiss ✕ | `<Button variant="close" look="panel" \| "hud" \| "art">` |
| a macOS push button (settings, dialogs) | `<Button title kind="default" \| "primary" \| "destructive" \| "plain">` |
| a menu-material panel with a scale-in | `Popover` (or `PopoverSurface` for the material alone); a panel placed by its own math uses `usePopoverMotion` + `usePopoverMotionStyle`; open/close state from `usePopoverPresence` |
| a row in a popover or menu | `MenuRow` and `MenuSeparator` |
| a `Surface` with a fill, corner radius, hairline border and shadow (cards, ghosts, HUDs) | `<Panel fill radius border shadow={level}>`; the level is a `ShadowLevel` from `tokens.ts` or the feature's `tokens.ts` |
| a centred modal over a scrim | `<Dialog width pad onDismiss>`; anchored to a spot with `place={{ top, right }}`; `Sheet` is the settings preset; `onSubmit` adds Escape/Enter keys, `restoreFocus` runs on close, `animated` fades it in |
| a view kept mounted until its exit fade ends | `usePresence(value, { show, hide })` from `motion.ts` |
| reduce motion | `reduceMotion()` and `reduceMotionKnown` from `components/ui` |
| a settings row / grouped rows | `Row` and `Group`; inside settings, `Row`, `SectionHeader` and `Anchor` from `components/settings/Form` add the search anchor |
| a text input / search box / pop-up menu / checkbox | `TextField`, `SearchField`, `PopUp`, `Checkbox` |
| an on/off switch | `<Toggle>` (settings) or `<Toggle look="panel">` (popovers) |
| a radio dot | `<Radio on look="form" \| "compact" \| "ring">` |
| a colour swatch with a selection ring | `<Swatch selected ring fill>` (children instead of `fill` for a gradient) |

## Coordinates: root points

Settings › Appearance › Interface size (`interfaceScale`, 0.8 to 1.5) scales every window's React root: the root
keeps its frame and takes bounds of frame / scale, so React lays out in **root points** and AppKit scales drawing,
hit-testing and conversions. JS speaks root points everywhere: styles, `onLayout`, `measure`, `measureInWindow`
(from the root's top left), touch `pageX`/`pageY`, and every rect or point it sends to native or gets from native for
layout. Native converts at the boundary with `ArdiaInterfaceScale` (Swift `InterfaceScale`).

- **Physical, never scaled:** NSWindow frames and screen coordinates (`window.frame`, saved and closed window frames,
  `littleArdiaSize`, `openWindow` frame and pointer, `windowFrame()`), PiP geometry, image pixel sizes, CSS
  coordinates that go back into a page, and diagnostics that say they are physical. A frame's size used for layout is
  divided by the scale: `windowRootSize` / `useWindowRootWidth` (`state/windows/rootSize.ts`) prefer the root's own
  `onLayout` size and fall back to `rootSizeOfFrame`. A point crossing between windows goes through the screen:
  `screenPoint` and `rootPointIn` (`state/drag/windowDrop.ts`).
- **Page points** (CSS pixels at zoom 1) are window points: a page's own size divides by the scale on its way into
  React (the extension popup's DOM size).
- The current scale lives in `state/settings/interfaceScale.ts` (`useCurrentInterfaceScale`, `currentInterfaceScale`,
  `onInterfaceScaleChange`, `onInterfaceScaleSettled` for re-measuring once the relayout is done). A cached measurement
  re-measures there; anchored popovers and menus close on a change (`state/app/interfaceScaleRefresh.ts`).
- One device pixel is `1 / (PixelRatio.get() × scale)` root points (`PixelRatio` stays the backing scale). Snap with
  `snappedToDevicePixels`, never `Math.round(x * 2) / 2`. `StyleSheet.hairlineWidth` stays half a root point at 2×: a
  hairline scales with the interface like every other length.
- Persisted UI lengths (`sidebarWidth`, `extensionSidePanelWidth`, theme metrics) are root points, so they mean the
  same at every scale.

## State

- Hover, pressed and open state of one component stays in that component's `useState`.
- Anything two components share, or anything saved to disk, lives in `state/<domain>/`: the store slice, its `useX()`
  selector hooks, its actions, and the effects that keep it in sync with the engine.
- Components read through `useX()` hooks and write through actions. Never `getState()` in a component.
- One way to create a store. Saved data has versioned migrations.

**One store shape.** A store holds data only, and the functions that change it are exported next to it:

```ts
export const useClearDataRequest = create<{ windowId: string | null }>()(() => ({ windowId: null }));

export const requestClearData = (windowId: string | null) => useClearDataRequest.setState({ windowId });
```

- Always the curried `create<T>()(() => init)`, never a store with methods inside or a `set`/`get` creator.
- `setState` is called only in `state/`, by the store's own domain (`state/<domain>/`). Other domains and components
  call that domain's exported actions.
- A store used by one component tree still lives in `state/<domain>/`. Only a store made per component instance
  (one per mounted provider) stays in that component.
- **The one exception is `useBrowser`** (`state/browser/store.ts`), the workspace store. Its actions stay methods,
  composed from slices (`createTabsSlice`, …), because the store tests (`S().newTab(…)`) and the scripts that drive
  a running app over CDP (`ac.store.getState().newTab(…)` in acceptance, the release smoke test and the perf benches)
  call them there. Components never call them on the store: each domain's `actions.ts` exports them as functions
  with `storeAction("newTab")`, next to the domain's own UI actions (dialogs, confirmations).

**Reads.** Components subscribe through hooks from `state/<domain>/hooks.ts`, never `useBrowser(…)` or a store's
`getState()`:

- A hook keeps the selector as narrow as the component needs: `useSettings((s) => s.tabLayout)`,
  `useTab(id, (t) => t?.title)`, `useWindow(id, (w) => w?.frame)`. Pass `useShallow(…)` through when the
  selector builds an array or object. Moving a selector into a hook never widens it: a component re-renders exactly
  when it did before.
- A selector that combines domains, or that two components share, becomes a named hook (`useWindowProfile`,
  `useIsBookmarked`).
- An event handler that decides from the current state calls a reader exported from `state/` (`currentTab(id)`,
  `currentSettings()`), or better, an action that makes the whole decision in `state/`.

**UI from state.** `state/` never imports `components/`. When an action needs UI (a sheet, a menu anchored to a
view, an animation), state exposes a request (a store field or an event) and a component renders it.

**Saved documents.** Every JSON document the app keeps in its data folder carries a schema version and reads through
`lib/savedDocument.ts`:

```ts
const VERSION = 2;
const MIGRATIONS: Migrations = { 0: unchanged, 1: (doc) => ({ ...doc, downloads: doc.items }) };

const saved = parseSaved(readDocument(DOC), VERSION, MIGRATIONS);
writeDocument(DOC, versionedJson(data, VERSION));
```

- A shape change bumps `VERSION` and adds the step from the old version (`MIGRATIONS[n]` turns version n into
  n + 1). Never branch on the shape instead.
- A document without the field is version 0. A version newer than the app knows, a field that isn't a non-negative
  integer, a missing step, or anything that isn't a plain object reads as nothing (the document's defaults), and is
  overwritten on the next save. Downgrades aren't supported.
- `session.json` and `downloads.json` are the exception (`state/session/sessionSafety.ts`). One that exists but is
  empty, broken, of an unknown shape (no session field at all, or core lists that aren't lists or row tables), or unreadable is
  never written over until the store has copied its bytes to `<name>-unreadable-<ms>-<n>.json`
  (`copyDocument`; a copy rebuilt from the decoded text doesn't count). The same goes for one that loading would
  partly drop: rows the reader rejects (windows, tabs, groups, splits, profiles, parked pins, the closed and cleaned
  lists, or a closed list that isn't a list), or anything hydration would discard. The check runs the same
  `hydratedLayout` (`state/browser/hydratedLayout.ts`) that the store's `hydrate` uses and counts every reference it
  discards: tabs, windows, window tab lists, group members and split panes. Such a file still loads what is whole, but it is kept
  aside first. Order and focus ids that name an Object property (`constructor`, `__proto__`) are dropped while
  reading. A download row the reader rejects keeps `downloads.json` aside the same way. Every retry reuses the same
  copy name, only one copy runs at a time, and a slow copy that succeeds late still opens the writes. An existence
  probe that fails counts as present: the stores call a file missing only on a confirmed "no such file" (on macOS,
  ENOENT with its folder present), so a permission error or a missing folder reads as unreadable and keeps the
  writes held. A copy whose source has gone fails with `ERR_DOCUMENT_GONE`, and only when
  the file is confirmed absent with its folder present. The gate then treats the document as missing: it recreates
  it from the current state with `createDocument`, so a file that reappeared at that name fails the create and is
  kept aside first. On Linux the copy never succeeds from cached text (#3872).
- A `session.json` newer than the app came from a newer build, after a rollback. It is never copied or written: the
  older build saves its own session to `session-older-build-v<its session version>.json`, restores that one first on
  its next launch (then the backups), and the newer build finds its file untouched when the user updates again
  (#3309). Each session version has its own file, so a second rollback never writes over the first one's. That file
  gets the same protection as `session.json`: a damaged or partly loaded one is copied aside before it is replaced.
  The older build's saves make no daily backups, so a newer build recovering from them never gets the rollback's
  session ahead of its own. Telemetry counts these launches as `session_set_aside_newer`. The Linux host's
  `session.write` doesn't do this yet.
- Until that copy lands, every write to the document waits. Quitting retries a copy that is waiting to retry and
  waits for each held document. Received synced tabs wait too, so a receipt never outruns the disk.
- The session then comes back from a backup. A session that reads but throws while it is prepared or hydrated
  counts as damaged too, and the next backup is tried. Backups that load whole are tried first, newest by `backupAt`,
  then ones that would lose rows. The backups are read only when the saved session can't be used. With no backup it
  starts fresh, and the download history still loads. A missing file is a first launch: nothing is restored.
- `readSaved` tells these cases apart, where `parseSaved` returns null for all of them.
- Backups are immutable files with rising sequence numbers: `session-backup-<n>.json` (daily) and
  `session-premigration-<n>.json`, each holding `{backupAt, session}`. A new file takes the highest number on disk
  plus one and is created with `createDocument`, which fails with `ERR_DOCUMENT_EXISTS` rather than overwrite, and
  then moves on to the next number. macOS links a fully synced temp file into place and syncs the folder (falling back from `F_FULLFSYNC` to `fsync`
  only when the filesystem reports it unsupported), and its
  `copyDocument` syncs the copy and the folder too. Windows moves a flushed temp file without replacing, with
  WRITE_THROUGH. Linux checks in JS only (#3872). `listDocuments(prefix)` lists committed regular files only, never
  staged writes or directories, and `removeDocument` deletes files only. Restore, cadence and retention share one
  order: backups whose `backupAt` is no more than a day ahead of now come first, then newest `backupAt`, then
  highest number.
  - A session save writes a daily backup when no backup that loads whole was made within 24 hours of now (by
    `backupAt`, not by weekday), so a clock that jumps back only adds a file. A clock that moves back also drops the
    wait for the next check, and a write that started before the jump doesn't bring it back. Retry waits use a
    monotonic clock. A failed backup is tried again five
    minutes later.
  - A launch whose `session.json` still needs a migration saves a pre-migration snapshot first, under one reserved
    name it retries until it lands. Names someone else took move it on to the next number within the same attempt,
    and a retry that finds its bytes already there asks the store to confirm they are durable (`syncDocument`) before
    it counts. and the migrated session isn't written until then.
  - The 7 newest daily backups and the 3 newest snapshots are kept, counting every numbered file, malformed ones
    included (they go first). Pruning never removes the newest backup that
    loads whole or the file just written, and nothing is pruned in a launch that is recovering a damaged session.
  - Each ordinary save adds no other writes.
- `versionedJson` writes the version last, so the payload can't override it. The reader still checks the payload it
  depends on: a version says which shape to expect, not that the data is valid.
- The field is `version`, except in `sync.json` (`v`) and `ardia-cli.json` (`schemaVersion`; its `version` is the
  installed CLI's version).
- Covered: `session.json` (10), `downloads.json` (3), `launch-look.json` (2), `air-traffic.json` (2), `bookmarks-cache.json`, `telemetry.json`,
  `telemetry-queue.json`, `telemetry-daily.json`, `release-notes.json`, `onboarding.json`,
  `default-browser-offer.json`, `sync.json`, `sync-extensions.json`, `live.json`, `shared-folders.json`, `ardia-cli.json`,
  `bangs-state.json`, `Scripts/status.json`, `link-sources.json`, `freeze-sends.json` and `imported-bookmarks.json` (all 1).
- Native code reads through `ArdiaSavedDocument` (packages/ardiacore/ios), with the same rules: `session.json` and
  `onboarding.json` (any version up to the one JS writes; a test pins each). `ArdiaSavedSession` also reads nothing
  when a field the early launch uses has the wrong type, so a malformed window falls back to the JS launch. and `launch-layout.json` (5, written and
  read by native code only, so any other version reads as nothing).
- The sealed sync files carry their own `version` inside the sealed JSON, because they're written apart from
  `sync.json` and its `v` doesn't cover them: the `sync-state.nns` checkpoint (`{ covers, clock, scopes }`, 1; version 0
  includes the older bare scope map) and each `sync-journal-<n>.nns` part (1). The single `sync-journal.nns` from before
  numbered parts is still read first and emptied with them.
- Out of scope: `config-schema/*.json` (regenerated at every launch, `docs/config.md`), the Keychain token JSON, logs (`dev-console.log`, `telemetry-requests.log`), dev and bench results
  (`dev-eval-result.json`, `layout-watch.json`), test fixtures (`calendar-fixture.json`), and the legacy
  `bookmarks.json` / `history.json`, which are migration inputs read once. The sync payload (log and snapshot files,
  `v: 1`) and `switches-cache.json` have their own versions.

## Workspaces

- Two pnpm workspaces. The root one is the Mac app and its packages (`apps/browser`, `packages/*` but
  `packages/phone`), on the Mac's Expo and react-native-macos. `apps/phone` is its own workspace with `packages/phone`,
  on the phone's Expo and React Native, with its own lockfile (docs/phone.md › Layout). They share only `@ardia/core`,
  plain TypeScript linked into the phone.
- A package belongs to one workspace, never both. Install each from its own root under `scripts/agent/locked pod`.

## Files

- Components are `PascalCase.tsx`; every other module is `camelCase.ts`. Tests sit next to the code as
  `camelCase.test.mjs` (or `PascalCase.test.mjs` for a component). A platform's twin of a file adds its suffix:
  `.macos`, `.ios`, `.windows`, `.linux`, `.win`, `.mac`, `.desktop`, `.web`, `.native`. `apps/desktop` resolves
  `.linux.*` (`--mode linux`), `.win.*` (`--mode win`) or `.mac.*` (`--mode mac`, the Mac WebUI shell), then
  `.desktop.*` (the Chromium desktop host, shared by all three), ahead of `.web.*`.
- At most 400 lines per TS/TSX file (`apps/browser/src`, `packages/*/src`), 600 per native file (`packages/*/ios`,
  `engine/ardiacore/src`, `engine/chromium/src`). Tests, fixtures and generated files (`packages/core/src/bangList.ts`,
  `packages/demo/src/shims/web/symbols/data.ts`, `apps/browser/src/lib/emojiData.ts` from `apps/browser/scripts/emoji-data.mjs`)
  are exempt, and so is `packages/ardiacore/ios/page_script.js`: it is
  injected as one closure into every frame, and its helpers share builtins captured before page code runs, so
  splitting it would need a bundling step. So is
  `packages/core/src/suggest.reference.ts`, the frozen spec the suggestion code was tuned against
  (`suggest.property.test.ts` holds the live code to it, `SUGGEST_BEFORE=1` benches it): it stays as written.
- One type per native file, named after it.
- No comments (AGENTS.md › Hard rules), in any source, script or config file the repository owns, including comments
  inside injected page JS and shader source held in strings. Allowed: license headers, shebangs, tool directives
  (`@ts-expect-error`, `eslint-disable`, `#pragma`, `swiftlint:`, `nogncheck`, `NOLINT`, `/// <reference`,
  `# shellcheck`, `# noqa`, `# type:`, `# yaml-language-server:`, `# syntax=`, `#Requires`, a lone `/** @type {…} */`),
  and the header a script prints as its `--help` (next to a `help`, `usage`, `-h` or `exit 64`): always the
  contiguous comment block at the top of the file, and only the part of it that a `sed -n 'A,Bp' "$0"` or
  `head -n N "$0"` prints, that an `awk … "$0"` or `step-guard.sh` prints, that a script reading itself
  (`readFileSync(… import.meta.url)`) splits and strips of `//` before printing, a Python module docstring the script uses
  as `__doc__`, and PowerShell comment-based help (`.SYNOPSIS`). Rust attributes (`#[…]`) aren't comments; Python
  docstrings and Rust `///` doc comments are.

## Names

- App-side ObjC classes and their files are `Ardia<Thing>`; Swift types use plain names (the module namespaces them).
- The engine's exported ObjC API is `ArdiaCore*`; engine C/C++ is `ac_*`.
- No `Cef*`/`CEF`/`cef` names, no `AC*` or app-side `ArdiaCore*` classes in `packages/*/ios`.
- No `Netnyahoo` or `NN*` names outside migration code (`LegacyMigration.swift`, `legacy.ts`, `*Migration.swift`,
  `*migrations.ts`).

## Translation layer (JS ↔ Expo modules ↔ ArdiaCore ↔ `ac_*`)

- **One way to call the engine:** `engine.call("downloads.pause", args)`, typed from one table
  (`packages/ardiacore/src/engine/api.ts`); native dispatches by name to the matching `ac_*` call. Only secrets
  (`callWithSecret`) and views get dedicated functions.
- **One error model:** engine errors reject with `{code, message}` (`ERR_ENGINE`, `ERR_UNKNOWN_CALL`,
  `ERR_CONTENT_BLOCKER`, `ERR_BAD_REPLY`, and `ERR_BAD_ARGS` when an argument is missing or of the wrong type: native
  reads each one as required or optional, never with a silent default); JS throws `ArdiaError` with the code. Refused, absent or unavailable
  answers are values in the function's return type (`false`, `null`, `[]`), not errors. The bridge never falls back
  silently; callers decide (`orWarn(x)` in `lib/fallback.ts` logs and falls back).
- **One event channel per module.** Event names are `domain.event`; payloads are parsed once.
- **IDs at the API surface** are `tabId` (the app's string), `windowId` and `profileId`. Browser ids, transfer keys,
  adopt ids and Chrome's int tab ids stay internal, resolved by one native registry. Per-tab operations live on the
  tab's API.
- **One `PageEngine` protocol** for the Chromium and WebKit page engines: same method names, one event table.
- **One Expo module per domain** (`ArdiaTabs`, `ArdiaDownloads`, `ArdiaExtensions`, `ArdiaProfiles`,
  `ArdiaPermissions`, `ArdiaWindows`, `ArdiaMenus`, `ArdiaSystem`, …), each in `<Domain>Module.swift`, registered as
  `Ardia<Domain>`.
- ArdiaShell links ArdiaCore directly and calls it with types: no selector strings or string notifications between
  them.
- **One authority per rule:** the engine's off-the-record flag alone decides private profiles; one helper builds
  profile directory names.

## Environment variables

Read once, in one place: `ArdiaLaunchConfig` (`packages/ardiacore/ios`) reads the environment at start and JS gets it
from `platform/launchConfig.ts`. No `getenv`, `ProcessInfo…environment`, `base::Environment` or `process.env` anywhere
else in app or engine code (scripts and tests outside the app runtime are free to). The engine reads command-line
switches, never the environment: the app passes `--ardia-test=<list>`, `--ardia-trace=<list>`,
`--ardia-switches=<list>` and `--ardia-<instance key>=<value>` to `ChromeMain`.

Three engine lines are exempt, by file and exact line (`ENGINE_ENV_READS` in the check); any other read in those files
still counts:

| File | Read | Why |
| --- | --- | --- |
| `engine/ardiacore/src/ardia/core/ac_main_delegate.cc` | `base::Environment` in `EnvironmentThatOpensTheProfile` and `KeepRealProfileClosed` (2 lines, 3 reads) | The profile gate checks for `SSLKEYLOGFILE` and unsets it outside a mock-keychain instance, so nothing records the TLS keys of the real profile. It guards against the environment, so it has to read it. |
| `engine/chromium/src/chrome/browser/ardia/ac_scripts_policy.cc` | `getenv("HOME")` | Expands `~` in a user script path the way the shell does. |

| Variable | Value | What it does |
| --- | --- | --- |
| `ARDIA_DATA_DIR` | path | The instance's data directory |
| `ARDIA_BACKGROUND` | `1` | Hidden instance: never activates, windows sit behind the owner's |
| `ARDIA_REMOTE_DEBUGGING_PORT` | port | CDP port |
| `ARDIA_INSTANCE` | `key=value,…` | The few other instance settings (downloads dir, update feed, extra Chromium switches, …) |
| `ARDIA_SWITCHES` | `name=on,…` | The only feature toggle, backed by the registry `platform/killSwitches.ts`: kill switches (on by default, at most 8) and experiments (off by default), each with an owner and `removeBy` |
| `ARDIA_TRACE` | `pip,visibility,…` | Trace logging per area |
| `ARDIA_TEST` | `keychain=file,reauth=granted,…` | All test fakes and fixtures |
| `ARDIA_FEEDBACK_URL` | URL | Where Report a Problem sends (`https://ardia.dev/api/feedback` otherwise); the `ardia` CLI reads the same variable (`docs/feedback.md`) |

- `ARDIA_TEST` and `ARDIA_TRACE` work only in a test instance (not signed for distribution, a scratch data dir, the
  mock keychain); a release build ignores them and logs that once. CDP, argv and extra switches reach Chrome only with
  the mock keychain.
- On Windows the engine's test gate (`scripts/windows/engine/src/ardia/win/test_gate.cc`) decides. Windows builds aren't signed,
  so a test instance there is an absolute scratch `ARDIA_DATA_DIR` that isn't, inside or around the real profile
  folders (compared by final path) and an `Ardia.test-build` marker beside `Ardia.exe`, which only test harnesses
  write and no installer ships. The test-only `ARDIA_INSTANCE` keys need it too
  (`docs/windows.md` › Test instances).
- An experiment ends by keeping the winning path and deleting the other branch and its toggle. One still being tried
  is an entry in the registry (`EXPERIMENTS`), not a new variable.
- Every key, area and value: `docs/agent-brief.md` › Launch variables.

## The check

`apps/browser/src/conventions.test.mjs` runs in `pnpm -C apps/browser test` and in `.github/workflows/conventions.yml`
on every pull request and push to `main` (plain `node`, no install, no paths filter), and checks, per file. Every rule above `comments` covers `apps/browser/src`,
`packages/*/{src,ios}` and `engine/{ardiacore,chromium}/src`. `comments`, `bare-sleep` and `expiring-skip` cover every
file git tracks in a language the scanners read (`apps/browser/scripts/conventions/scanners.mjs`): JS/TS (and
`tsconfig*.json`), Swift, C/C++/Objective-C/Mojo/Java, Kotlin and Gradle, Rust, CSS, shell (by extension or shebang),
PowerShell, Python, YAML (in a workflow or `action.yml`, `run:` as the shell that step uses and an
`actions/github-script` `script:` as JS; elsewhere a block scalar is text), TOML, GN, Ruby
(`Podfile`, `.podspec`), Dockerfiles, HTML, Astro and XML. Left out: `node_modules`, lockfiles, `gradlew`, `fixtures/`
folders outside the scopes above, any folder holding its own `LICENSE` or `COPYING` (a third-party copy), files whose
first lines say they are generated, and `packages/ardiacore/src/engine/generated`. Outside the first scope, JS held in
strings isn't scanned: there, those strings are test fixtures.

| Rule | What it counts |
| --- | --- |
| `layout` | an app file outside the folders above |
| `imports` | an import against the direction table, or into a file outside the folders (a component importing `platform/` included, except `components/dev/devHarness.ts`) |
| `native-calls` | a native package, `expo-modules-core` or `NativeModules` used outside `platform/` and `components/ui/` |
| `tokens` | a colour literal (`"transparent"` included: use `ink.clear`), `Easing.` curve or numeric duration outside `tokens.ts`/`motion.ts` |
| `scale` | in `components/` and `App.tsx`, outside `tokens.ts`/`motion.ts`: a `fontSize`, `letterSpacing`, radius (`radius`, `borderRadius`, `cornerRadius`, `shadowRadius`, …), `padding*`, `margin*`, `gap`/`rowGap`/`columnGap`, or spring `damping`/`stiffness`/`friction`/`tension`/`bounciness` whose value starts with a non-zero number (`9`, `-3.5`, `10 * g.s`) or has a numeric ternary branch; use the `font`, `radius`, `space` and `springs` scales (`concentric()`, `capsule()` for derived radii). Sizes, offsets, `lineHeight`, computed values and `lib/`/`state/` geometry don't count |
| `get-state` | `getState(` in `components/` |
| `set-state` | `.setState(` in `components/` |
| `store-reads` | `useBrowser(` in `components/` (read through `state/<domain>/hooks.ts`) |
| `store-shape` | a zustand store not created as `create<T>()(() => init)` (a `set`/`get` creator, or the uncurried form) |
| `native-loops` | `Animated.loop(` around `Animated.sequence(`, `parallel(` or `stagger(`: React Native can't run those as a native loop, so JS restarts every leg and macOS starts a new display link each time. Use `nativeLoop(value, legs)` from `components/ui/motion.ts` |
| `size` | a file over its line cap |
| `env` | an environment read outside the launch config and the three exempt engine lines |
| `naming` | a `Cef`, `AC*`/app-side `ArdiaCore*`, `Netnyahoo` or `NN*` name |
| `comments` | a comment that isn't a license header or tool directive |
| `file-names` | a file name breaking the PascalCase/camelCase rule |
| `bare-sleep` | a sleep that no loop bounds by a count or a deadline: `sleep N` in shell (and in a workflow's `run:` block), `Start-Sleep`, `time.sleep`/`asyncio.sleep`, and in JS tests `await sleep(…)`, `await new Promise((r) => setTimeout(r, N))`, `timers/promises`' `setTimeout` or a local helper that waits its argument. A sleep inside a `for … in`/`for … of` loop, a loop whose header reads a deadline (`deadline`, `SECONDS`, `Date.now()`, `time.monotonic()`, `attempts`, …) or compares a counter that the loop's update clause or body advances, or a loop whose body reads one on a line that breaks, exits, returns or throws, is a bounded poll and doesn't count (`for ((;;))` and `while true` with no such line are open-ended); in JS a zero delay (`await sleep(0)`, `setTimeout(r, 0)`) is a tick, not a wait, and doesn't count. Wait on the condition instead: `scripts/agent/await` in shell, a deadline loop elsewhere. `scripts/agent/await` itself and `infra/` (services, whose sleep is a schedule) are exempt |
| `expiring-skip` | an unconditional skip, `todo`, quarantine or accepted risk without an owner and an expiry (below), or any `.only`; a passed expiry only warns |

`apps/browser/src/conventions-baseline.json` lists the violations that existed when the rules arrived, as
`rule → file → count`. Since 2026-10-26 the original rules hold everywhere but for a few `size` and `naming`
entries; `comments`, `bare-sleep` and `expiring-skip` carry the debt the repository-wide scan found when they
arrived, to be paid down file by file. It stays a ratchet: the test fails on any violation beyond the baseline, and on any baseline entry
higher than what the file has now, so fixes must lower their entries.

- `node apps/browser/src/conventions.test.mjs --report` prints every violation grouped per rule, and the difference
  from the baseline (`--from-head` to scan HEAD instead of the working tree).
- To update the baseline, stage your own hunks, then run
  `node apps/browser/src/conventions.test.mjs --write-baseline` (it scans the git index, so unstaged work stays out;
  check `git diff --cached --stat` lists only your files first, or use `--from-head` to scan HEAD) and commit the baseline with your change. It refuses to write when a rule's
  total grows. The one allowed growth: `imports` may grow while `layout` shrinks, because a file moved out of the old
  layout starts having its imports checked. Moving or renaming a file moves its entries under the new path.
- Never add violations to the baseline by hand. `--force` overrides the refusal and needs the owner's OK.
- The baseline counts per file and rule, so swapping one baselined violation for another of the same rule in the
  same file passes. Fingerprinting each violation would close that, at the cost of a baseline that churns with every
  edit near a violation; review catches a swap, and the count can only go down.
- `--show <path>…` prints each comment the check counts in those files, with its line.

### Skips and accepted risks carry an expiry

A test that is skipped or marked `todo` whatever the machine, a quarantined case and an accepted risk each carry an
owner and a date, in this form:

- A test's reason: `@<github login> until <YYYY-MM-DD>: <why, with the issue>`. In `node:test`, the options form
  `test("…", { todo: "@mantrakp04 until 2027-01-31: C5 open, #3569" }, fn)` (also `skip:`, quoted or not, or a
  `const` holding the string; only the options object passed straight to `test`, `it`, `describe`, `suite` or
  `context` counts); `skip()`, `todo()` and `only()` imported from `node:test`, `test.skip(`,
  `test.todo(`, `describe.skip(` and `skip: true` have no place for it and count. Python `@unittest.skip("…")`,
  `@pytest.mark.skip(reason="…")` and an unconditional `@pytest.mark.xfail(reason="…")`, Swift Testing
  `.disabled("…")`, JUnit `@Ignore("…")`/`@Disabled("…")` and Rust `#[ignore = "…"]` take the same string.
- A list entry (`apps/browser/scripts/sim/known.json` › `failing`): `"owner": "@<login>", "expires": "<YYYY-MM-DD>"`.
- A skip on a condition (`{ skip: !onMac && "needs a Mac" }`, `skipIf`, `.disabled(if:)`, `t.skip()` inside a test)
  names an environment, not a debt, and needs neither. `.only` never belongs in a commit.

A missing owner or date counts against the baseline like any rule. A claimed date that isn't one (`until 2099-02-30`,
`"expires": "soon"`) and any `.only` fail the check outright, baseline or not. A date that has passed (UTC) only
warns, so the calendar never breaks an unrelated pull request: the check prints a `::warning` annotation for it (a
diagnostic under `pnpm -C apps/browser test`) and passes. Fix the case, or move the date with the owner's OK.
`--expired` runs only this part (`--summary <file>` appends a Markdown list), and
`.github/workflows/expiring-skips.yml` runs it every Monday and shows the lapsed dates in the run's summary.

React Compiler isn't enabled (`apps/browser/babel.config.js` uses `babel-preset-expo` alone), so the check has no
bail-out rule.
