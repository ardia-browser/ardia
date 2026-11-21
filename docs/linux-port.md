# Ardia on Linux

The Linux port runs the same browser UI as the Mac app on the same Chromium (158.0.8127.36) and Helium (0.22.1, with
helium-linux 0.22.1.1) pins. It targets x86-64 Linux on Wayland, with Hyprland and Omarchy as the main desktop; X11
works, and arm64 builds are configured but untested. It answers upstream issue #1, "Linux Support".

On the Mac, ArdiaCore is a framework that the React Native app hosts. On Linux there is no React Native: Chromium's own
`chrome` executable is the app. It serves Ardia's UI from `chrome://ardia/` inside each browser window and hands the
UI one privileged bridge, `window.__ardiaHost`. ArdiaCore is linked into `chrome`; there is no separate
`libardiacore.so`.

The acceptance suite is in [linux-acceptance.md](linux-acceptance.md) and CI in [linux-ci.md](linux-ci.md).

## Where things live

| Path | What |
| --- | --- |
| `apps/linux` | The Linux UI entry point. Vite builds it from the shared `apps/browser` components into `apps/linux/dist`. It holds the Linux adapters (native modules, WebView, menus, window controls, wording transforms) and the acceptance suite. |
| `engine/ardiacore-linux` | The Aura host and every Linux-only native service (`src/ardia/linux/ac_linux_*`), the content blocker's bridge page, and their tests. It is the Linux patch-series layer. |
| `engine/chromium/src/chrome/browser/ardia` | The shared engine services (`ac_*`), the `ardia` command's token server (`ac_cli_control.cc`, `ac_cli_token_policy*`) included. Linux-only parts are `ac_reauth_linux.*`, `pip/ac_pip_linux.cc` and `pip/ac_pip_hyprland.*`, behind `is_linux` in `BUILD.gn`. |
| `engine/patches/chromium-linux-*.patch` | Chromium hooks the Linux host needs. They are selected with `linux` in `engine/patches/series`. |
| `scripts/linux` | Build, package, install, engine publish and fetch, smoke gate, CI checks, the polkit policy and the Arch `PKGBUILD`. |
| `.github/workflows/linux.yml` | The Linux workflow ([linux-ci.md](linux-ci.md)). |

`packages/demo` (the ardia.dev web demo) has no Linux code and nothing under `apps/linux` imports it.

## Architecture

### The shell and its bridge

- **Startup.** `chromium-ardia-linux-layer.patch` calls `ardia::StartLinuxHost()` from
  `ChromeBrowserMainParts::PostBrowserStart()`. Each browser window gets a `ShellHostView` (`ac_linux_host.cc`). It
  lays a WebView over Chromium's `BrowserView` client area and loads `chrome://ardia/` into it. Chromium keeps
  ownership of `Browser`, `BrowserWindow` and `TabStripModel`, and its normal browser delegates.
- **Assets.** These come from `lib/ardia/ardia-ui` beside the executable, or from `--ardia-ui-dir` during development.
  The data source serves them only to a host's own shell `WebContents`. An ordinary tab that navigates to
  `chrome://ardia/` gets nothing.
- **Code cache.** `chromium-linux-auto-pip.patch` turns on Chromium's `WebUICodeCache`, so V8 keeps the shell's
  compiled scripts between launches. Chromium keys each entry by the script's URL and a hash of its source, so an
  updated bundle never runs old code. On an existing profile (Xvfb, llvmpipe, a shared box, median of 5 interleaved
  runs) the shell's first contentful paint went from 1.83 s to 1.46 s and its `DOMContentLoaded` from 1.51 s to 1.17 s.
- **Startup tab.** While the shell loads, the launch window reads the saved session on the file thread and starts the
  page it will restore (`ac_linux_startup_tab.*`): the active tab of the window `initialHostSession` restores (the
  saved `main`, or the first saved main window when `main` has no tabs), when restoring is on, the tab is idle and on
  the window's profile, and its address is `http` or `https`. It loads in the strip's blank first tab (Chrome's new
  tab page), or in a new background tab when there is none, and no binding owns it. The shell's first `tab.create`
  for that address takes it instead of opening another, whatever its page has redirected to since. Nothing starts for
  a utility, Little Ardia or private window, a launch that brought addresses from another app, or an empty session.
  A started page the shell hasn't taken after 30 s is closed, or turned back into a blank page when it is the strip's
  only tab, so the window never closes with it.
- **CSP.** The shell's policy is `default-src 'none'`, `script-src 'self'`, `connect-src 'none'`, `frame-src 'none'`,
  `object-src 'none'`, `form-action 'none'`, and `trusted-types ardia-symbols`. The UI can't reach the network.
  Search suggestions, live folders, favicons, import and telemetry all go through native services. The one Trusted Types policy
  renders the generated icon markup (`apps/linux/src/shims/web/Symbol.tsx`).
- **The bridge.** `window.__ardiaHost` is defined by the generated `bootstrap.js` before any Vite module runs. Its
  bootstrap reports `appBuild: "linux-host"`. A request is accepted only when `ShellHostView::Trusted()` holds:
  - it comes from the host's own shell `WebContents`;
  - it comes from the live primary main frame;
  - that frame's committed origin is `chrome://ardia`.

  Pages never get the bridge. The native bridge resolves profile ids to loaded `Profile` objects and runs every call
  on the UI thread. The bootstrap rejects a native request after 30 s, and slow calls such as calendar and sync have
  longer deadlines.
- **Calls.** The shared UI keeps its domain calls (`engine.call(name, args)`) and events. On Linux a call takes the
  first of these that handles it:
  1. typed Linux handlers (credentials, site controls, Memory Saver, live folders, calendar, sync, import and others);
  2. the generated route table `linux_contract::kRoutes`;
  3. the additive `ac_engine_call(name, profile_dir, args_json, reply, context)` dispatcher in
     `public/ac_engine.h`.

  The dispatcher routes only generated, known service names, and `AC_ENGINE_ABI_VERSION` stays 2. Unknown names
  answer `ERR_UNKNOWN_CALL`. The bootstrap lists the capabilities a host serves, and Settings hides rows whose backend
  is absent rather than showing a control that fails.
- **Mac-only modules.** These answer from `apps/linux/src/appModuleFallbacks.ts`, either with an honest empty value or
  with `ERR_UNAVAILABLE`.
- **Page options without a backend.** The shared UI mirrors a few settings to the engine at every launch
  (`webView.setVideoUpscaling`, `setCommandScrollZoom`, `setDisplayMediaPicker`, `setPeekOtherSiteTabs`,
  `setLittleArdiaOpensNewTabLinks`). While a host doesn't advertise one, the shell settles that call itself with
  `null` (`PAGE_OPTION_CALLS` in `hostModules.ts`) instead of sending it to be refused with `ERR_UNKNOWN_CALL`; its
  Settings row is hidden by the same capability. A host that advertises the call gets it. The current host
  advertises `setCommandScrollZoom`, `setPeekOtherSiteTabs`, `setLittleArdiaOpensNewTabLinks` and
  `setBlockAutoplayEverywhere`.
- **Block autoplay on every site.** As on macOS, a page's autoplay is blocked when its site's autoplay setting is Block,
  or when `webView.setBlockAutoplayEverywhere` is on and the site has no exception of its own (`ac_linux_autoplay.cc`).
  It covers web pages and local files (`http`, `https` and `file`); the shell and extension pages keep Chromium's
  own policy. Turning it on or off re-sends the config to open pages and updates Chromium's own autoplay policy for them.
- **Theme swatches.** `ThemeSwatch` (the Mac's `ThemeSwatchView`: the anonymous-ID avatar, the theme editor's
  swatches, preview and colour pad) is drawn by the shell (`shims/shaders.tsx`, `shims/web/gl/themeSwatch.ts`): the
  same 17 Oklab samples and start and end points as `ArcGradientLayer`, the third colour's overlay, the hue pad, and
  `GrainLayer`'s four tiles from the same generator.
- **Onboarding meadow.** `Meadow` (the intro's scene) runs ardia.dev's own meadow (`apps/site/src/scripts/meadow`,
  the source the Mac's `ios/Meadow/index.html` is built from) straight in the shell, since the shell CSP allows no
  frames (`shims/web/gl/meadow.ts`, imported as `@ardia-site/meadow/*` and compiled by `vite.config.ts` without the
  site's Astro tsconfig). It loads as its own chunk when the intro mounts, shows the Mac's dawn poster for the window's
  shape (morning with reduced motion, none at night) until the first frame, cross-fades in over 0.4 s, and reports
  the text tone and halo the same way. The scene draws at the display's rate, drops to 30 fps when idle, stops when
  the page is hidden or off screen, and the intro's unmount disposes it and loses its WebGL context. A software
  renderer (SwiftShader, llvmpipe) keeps the poster instead. Unlike the Mac's WebKit view, the scene gets the
  pointer, so the grass brushes and the sun can be dragged.
- **Intro music.** The shell plays the Windows app's `IntroMusic.wav` (rendered from the Mac's synthesis) with an
  audio element from its own assets (`introMusic.ts`; the shell CSP has `media-src 'self'`), starts it muted when the
  intro is, fades it on mute and stop, and keeps quiet in a hidden instance unless `allowAudio` is set. An engine
  without `media-src` refuses it, and `intros_music_failed` counts that.

### Tabs and viewports

- **Ownership.** Each real tab stays in Chromium's `TabStripModel`. Releasing a native tab detaches its viewport;
  only an explicit close ends the tab. Moving or remounting a UI view never closes its tab.
- **Reopened and duplicated tabs.** As on macOS, every tab of a regular profile is tagged with its key
  (`ac_tab_restore_tag`), so Chromium's `TabRestoreService` keeps the key with a closed tab's navigations. Tabs in
  private windows and temporary web views (a `WebView` with no tab id) aren't tagged. Reopening a closed tab or window
  (`restore:<key>`) reads them (`ac_tab_restore_take` with `keep`) and recreates the tab with `chrome::AddRestoredTab`,
  with its back and forward history. Only then does it drop the entry (`ac_tab_restore_forget`), so a restore that fails
  because its window or profile went away leaves the closed tab reopenable. Duplicating a tab (`clone:<key>`) clones
  its contents. Either falls back to loading the URL when nothing was saved. The host advertises this as
  `tab.adoptCopies`; without it the shell sends neither id, and the tab loads its URL instead of failing.
- **Placement.** Rectangles arrive in CSS viewport coordinates and the host converts them. Native pages hide beneath
  browser overlays and clip themselves.
- **Tracking.** `watchTabViewport` measures a page's rectangle, overlays and coverage only when something changes: a
  DOM mutation, a resize, scroll or visibility change, a CSS transition or animation, or a page's own presentation
  change (`refreshTabViewports`). It measures at most once per animation frame. It keeps measuring each
  frame only while a running animation targets the page's ancestors or an overlay. Idle windows run no measuring code;
  the earlier version polled every frame and used about 5% of a core. Mutation-triggered measures run in the next
  frame rather than in a later task, so a React commit and the animated transform that offsets it are never seen
  apart. Each tab keeps at most one `tab.viewport` request in flight; later rectangles replace the queued one, so a
  busy browser thread can't build up a backlog of stale positions.
- **Overlays.** The shell WebView sits above the page views and is transparent over them (`ShellHostView::Restack`,
  `ShellTransparency`), so menus, hover cards, popovers, the command panel and the sidebar peek draw straight over the
  live page, as on the Mac. Each overlay registers an input region (`useInputRegion`); the shell sends
  `shell.inputRegions` (page rects minus overlay rects) and the host passes input at those points through to the page
  below: Views and Aura targeting on the shell, plus `BrowserView::ShouldDescendIntoChildForEventHandling` for drag and
  drop (`chromium-linux-shell-above-input.patch`). An overlay that newly covers a page stays hidden until its region is
  acknowledged, so a press on its first frame can't reach the page. When a page takes the pointer from the shell, the
  host sends the shell a mouse leave (`LinuxPageChannel::ReleaseShellPointer`), so a sidebar hover card closes when the
  pointer moves straight from the sidebar into the page.
- **Peek.** The Peek card is a page overlay that hosts its own page (`PeekOverlay.tsx`, marked
  `data-ardia-page-stack`). The source page stays live and dimmed under the scrim: points of a page that fall on a
  page in a stack above it don't hide it, but one wholly under that page is hidden (full-screen Peek). Inside the
  stack, the shell elements painted before the peek page and under it (the scrim, the card's panel) are cut where the
  peek page shows, and a page below the stack doesn't cut the card's own surfaces. A page hole that overlaps an
  earlier one adds only the part outside it, so the even-odd clip never paints the shell back over the peek page.
- **Glass panels.** Menus, hover cards, the command panel, popovers and the extension popup's panel can be
  translucent over the live page. Every other panel, and every control, keeps the opaque fallback, and
  `isLiquidGlass` stays off. The sidebar peek's panel opts in too, but the peek covers it with the window's opaque
  gradient, which is never cut out of the page (see Upstream syncs, the two-tone strip).
  - **Native blur.** The shell sends the glass rects it wants (`shell.glassRegions`: id, rect, per-corner radii, blur
    24, opacity, in shell CSS px, with a generation). The engine draws one transparent layer per region with a backdrop
    blur and plain circular corners (`ShellGlassView`, `ac_linux_glass.cc`). It answers with the regions it applied and later reports `presented` for that generation. A shell
    renderer that goes away takes its regions and its pending `presented` reports with it, and the shell ignores a
    `presented` newer than anything it sent.
  - **Translucency is earned.** A panel starts opaque. It turns translucent only once its region for its current
    geometry has been stable for two frames, with no animation or transition running on it or an ancestor, and is
    presented. It goes opaque again the moment it moves, resizes, fades or an animation starts on it or an ancestor (not inside
    it), and the moment it falls past the region limit. A refused or
    never-presented region keeps it opaque, and so does the absence of the capability. A region that leaves the set
    the shell sends loses its acceptance, so coming back waits for a new answer and presentation. Panels mounted while
    glass was off register when it comes back.
  - **Who blurs what.** The native layers blur the pages, side panels and DevTools below the shell. Shell content
    behind a panel is blurred by the panel's own CSS backdrop filter. Native extension popups sit above everything
    and are never blurred.
  - **When it's off.** Glass needs `kNativeViewHostManagesLayers` and GPU compositing, as content's own compositing
    state says (`--disable-gpu-compositing` and a runtime fallback to software both count; Chromium 158 dropped
    the per-compositor software switch).
    Software compositing, SwiftShader and llvmpipe advertise `glassPanels: false`, and a runtime fallback turns glass
    off at once.
  - **Video.** Glass over playing video, in a page, a side panel or the in-window player, stays live. Viz never
    promotes video to an overlay here: Wayland overlay delegation is off by default and needs a compositor without
    `wp_fractional_scale_v1` (sway and Hyprland both have it), the X11 overlay processor is a stub, and even forced
    overlays skip candidates covered by filtered quads, except ones that require an overlay (hardware-protected,
    required-priority or video-hole candidates; Linux can't produce protected buffers today, so revisit a guard if
    hardware-protected playback ever ships). Glass over video costs about 2 points of GPU-process CPU,
    with the same p95 frame interval and no dropped frames.
  - **Stacking.** `ShellHostView::Restack()` keeps one order: pages (page views, DevTools, side panels), then the views
    put in the under-glass slot (`SetStackSlot(view, StackSlot::kUnderGlass)`, in the order they were added), then
    the glass layers, then the shell, then native extension popups. The in-window picture-in-picture player is in
    the under-glass slot, so glass panels over it blur it; the slot forgets a view when it is deleted.
  - **Removal.** A translucent panel that disappears leaves a same-looking afterimage until the layer's removal is
    presented (250 ms at most), so the blur never shows without its panel.
- **Extension popups and side panels** are native views (`ac_linux_extension_views.cc`).
  - **Popups** sit above the shell. The shell sends where a popup hangs (`extensionView.place`: the anchor and the
    room, in shell CSS px). The engine sizes it from the extension's own auto-resize, capped by that room, places it on
    whole device pixels and rounds its corners. It reports the frame it actually composited (a `frame` event, in shell
    CSS px), and the shell draws the panel's border and shadow outside it, so the page never covers them.
  - **Reveal.** The content shows once the page has loaded and stopped resizing (best effort, 600 ms at most) and the
    shell has painted the decoration of its current frame. It then fades in and reports `shown`. A focus asked for
    earlier is handed over only after that, and whatever had focus before a popup or side panel took it gets it back
    when the surface hides or closes.
  - **Focus in an inactive window.** A popup or side panel takes focus only while its window is active
    (`SurfaceFocusFor`). In an inactive one it is only remembered as the view to focus at the next activation. Views
    activates an inactive window when one of its views asks for focus (`FocusManager::SetFocusedViewWithReason`), and
    `BrowserView` answers a window's first activation, and any activation after a tab switch made while inactive, by
    focusing the active tab's page. That page then reported `focus` and the shell closed the popup: the first click
    on a pinned extension in a background or headless instance opened its popup for half a second. A window the user
    clicks in is already active, so this never showed on a desktop, but an inactive window raised itself. With no room at all, the popup and its panel hide until there is room again.
  - **Side panels** sit with the pages below the shell. The shell sizes them (`extensionView.viewport`), rounded
    inward like the page input regions, with the corner radii of the card that clips them.
- **Split panes.** Each pane keeps its own stored focus. A click in the inactive pane activates it.
- **New Tab prewarming** is off on Linux (`newTabPrewarm` is forced false in `ac_launch_switches_linux.cc`). A
  prewarmed native tab took focus from the search field when it was activated. Linux creates the page when the user
  submits a destination.

### Sessions and documents

- **Session writes.** Each write carries a baseline and a proposed snapshot. The native file worker writes in order
  and merges local changes into the latest stored snapshot, so concurrent edits in other windows survive.
- **Canonical events.** These sync every renderer while keeping its pending edits. The renderer that sent a save gets
  its own snapshot as the next base; its peers get the previous canonical base.
- **Native window ids** are fixed after bootstrap. A new window doesn't reapply the launch restore policy.
- **Canonical documents.** `LinuxDocuments` (`ac_linux_documents.*`) keeps the canonical copy of shared documents
  such as live folders and calendar settings in `live.canonical.json`, one per regular profile. Each write carries a
  revision and is merged by identity, with tombstones. Private and isolated profiles fail closed. The store imports the
  old `live.json` once.
- **Window close.** A close request waits until pending writes are sealed on the worker. The 30 s native deadline
  cancels the close; it never forces it. A save failure leaves the window open for a retry. Killing the process
  bypasses all of this.
- **Little Ardia windows** aren't saved to the session, so the renderer of a new one can't learn its kind from it.
  The opener leaves the window and its tab in `localStorage` (`ardia.smallWindow.<id>`, `hostSmallWindows.ts`), which
  every regular shell shares; the new renderer takes it once at startup, within 60 s, and starts as that small
  window, on its command bar when its tab is blank. Once the native window has opened, the opener forgets its copy
  without closing the window, so the window lives in one store only and a tab it moves to the main window
  (Open in Ardia) arrives through the session like any other. The opener also sends the Mac's frame: the saved
  Little Ardia size, at least 420 by 300, centred in the work area. With an engine that advertises
  `ArdiaShell.smallWindows` the shell does neither: the opener passes the same window and tab as `smallWindow` in the
  `openWindow` options and no frame, and the new renderer reads `windowKind` and `smallWindow` from its bootstrap
  (a relayed window has no 60 s limit). A bootstrap whose `windowKind` isn't `"small"` takes no seed at all. See
  Small windows below.
- **Private data.** Private and transient state never reaches a persisted snapshot. `ValidLinuxSession` rejects a
  session that carries private data.
- **Closing the last window.** When the native close ends the session, the window stays in the saved session and comes
  back at the next launch; otherwise it moves to closed windows. Either way its tabs aren't lost, so closing the last
  regular window never shows the close-tabs warning, as on macOS. A launch that doesn't restore windows turns each
  saved window into a closed window the way `closedForLaunch` does (tab layout kept, macOS's last-window marks and
  empty entries dropped). The snapshot saves every field the shared session saves except the Mac's early launch tab,
  including which settings were chosen (`settingsMeta`); `session.test.mjs` fails when the shared session adds one.

### Pages

- **Page channel.** The page script runs in an isolated world with an opaque origin and CSP
  `script-src 'none'; object-src 'none'`. Its messages reach the host only through a bounded channel:
  - the sender comes from the target frame, never from the message;
  - message kinds are allowlisted;
  - a kind is at most 32 B and a payload at most 64 KiB;
  - each document gets 64 messages, 32/s and 512 KiB;
  - 256 refusals mute that document.
- **Evaluation.** `evaluate` runs only fixed, hash-pinned operations, and anything else gets
  `ERR_PAGE_EVALUATION_REFUSED`.
  - `apps/linux/scripts/page-operations.mjs --write` generates the table (`ac_linux_page_operations.h`) from the shared
    sources; `--check` and `pageOperations.test.mjs` fail when it is stale.
  - Reader view uses six of them. `readerCheck`, `readerState` and `readerHide` are fixed texts. `readerToggle`,
    `readerOpen` and `readerSetLook` pin everything before the look and a fixed suffix after it. The host accepts only
    `{dark, size, font}` with exactly those keys, a boolean, a size index inside `READER_SIZES` and a font from
    `READER_FONTS`, and it writes its own canonical copy of the look into the script.
  - Every operation runs in the page's Ardia isolated world, so the reader's state on
    `window[Symbol.for("ardia.reader")]` lasts across calls for one document. Its overlay, `inert` and key listeners act
    on the shared DOM.
  - The element picker (Hide Element) uses five. `elementPickerCancel` is the shared text; `elementPickerApply` and
    `elementPickerUnhide` pin the shared call around its selectors, and the host accepts only a list of at most 512
    non-empty strings of up to 3072 bytes, which it re-escapes. The shared `start` waits on a promise the host can't
    await (Chromium runs isolated-world scripts without waiting), so the shell (`elementPickerHost.ts`) sends
    `elementPickerStart` instead, the shared start with a fixed suffix that leaves the pick on the picker, and then
    `elementPickerTake` every 120 ms until the pick settles or the page goes away. The host accepts `null` or two
    finite coordinates within a million pixels as the start's point.
  - `pageOperations.test.mjs` checks every operation, with its widest arguments, against the host's code cap.
- **Gestures.** Peek and split open only after a real left mouse-up. A dragged link opens only when it is dropped back
  on a page.
- **Page commands.** Find, Print, Save Page and DevTools (`ac_linux_page_commands`, `ac_linux_find`) act on the exact
  pane. DevTools docks inside the tab's pane and follows its tab across windows.

### Profiles and private windows

- **Profile ids.** `""`/`default` is the app profile. An isolated profile is
  `<letter>[A-Za-z0-9_-]{0,127}`, stored at `<user data>/Profile <id>`. Anything else is `ERR_PROFILE_INVALID`.
- **No fallback.** Nothing falls back to another profile: a tab runs in the engine profile it was created for, and a
  call names its profile explicitly.
- **One window, several engine profiles.** As on macOS, a regular window shows tabs of every regular profile, and
  switching profile pages the window in place. Profiles with Share data on have the same `dataId`, so they resolve to
  one engine profile and use one Browser; profiles with Share data off are separate engine profiles. Share data is
  chosen when a profile is created and can't be changed later, on macOS and Linux alike.
  - Chromium requires a tab's profile to match its Browser's, so each `ShellHostView` keeps member Browsers: the
    window's own Browser plus one hidden companion Browser per other engine profile its tabs use
    (`EnsureMember` in `ac_linux_host.cc`), the model of macOS's `WindowHost::BrowserFor`. A companion is created on
    demand with `omit_from_session_restore` and no session-restore trigger, and is refused while the window closes,
    during quit and when Chromium refuses a window for the profile. Its tabs stay in its own `TabStripModel`; the
    visible window shows them in its own viewports exactly like its own tabs.
  - A companion is a stock `BrowserView` whose widget is never shown. `chromium-linux-companion-browsers.patch` hands
    its `Show`, `ShowInactive` and `Activate` to the host, which focuses the visible window instead, drops its
    `Restore`, `Maximize`, `Minimize`, `SetBounds`, `Deactivate`, `FlashFrame` and fullscreen, synchronous or
    asynchronous (`RequestFullscreen`; Aura's `Restore`, and `Maximize` from minimized, show the window themselves), and hosts its tab-modal dialogs and permission prompts in
    the visible window's `BrowserView`, so no extension call (`chrome.windows.update` with any state, focus or bounds,
    `chrome.tabs.create`) maps a second toplevel. A
    widgetless `BrowserWindow` (as
    macOS's `ACBrowserWindow`) was the alternative; on Linux it would need the `BrowserWindowCreateParams::window`
    `CHECK_IS_TEST` lifted and the viewless accommodations `engine/ardiacore/apply.sh` makes for the Mac in about ten
    Chromium files, and `BrowserView::GetBrowserViewForBrowser` would resolve an adapter to the wrong Browser.
  - The companion `BrowserView` still attaches its active tab to its own contents view; after every change to any
    member's strip the host detaches every member's contents view before reattaching its viewports.
  - Companions aren't hosts: they get no shell, no window id, no focus ledger entry and no unclaimed-tab announcements
    of their own, `engine.info` doesn't count them, and Chrome keeps an empty one open while its window is open.
  - Each member reports its own strip (`tabs.strips`): its session id as `strip`, the visible window as `window` and
    `appWindow`, and its engine profile. Strip commands go to the member that owns the strip, and the tab-strip
    observer reads the strip that notified it.
  - A tab moved to another engine profile is recreated in the destination profile (`CreateTabIn` drops the old binding
    and its contents); a tab moved to another window keeps its contents only when the profile matches, and lands in
    the destination window's member for that profile.
- **Profiles load when opened.** As on macOS, a launch loads only the profiles its windows show. The others, with their
  extensions and uBlock Origin, load the first time a window shows one or a call needs their engine data.
  `startHostData` starts the shared `state/profiles/profileLoading.ts`, which also honours Settings › Advanced ›
  Performance › Load profiles when opened and the `lazyProfiles` kill switch. Native reports what `ProfileRegistry` has
  loaded through the `profiles.loaded` call, and a later load through the event of the same name, to every window. An
  engine without the call answers `ERR_UNKNOWN_CALL`, and every profile loads at launch.
- **Unloading idle profiles.** Settings › Advanced › Performance › Unload inactive profiles works as on macOS: the
  shared `state/profiles/profileUnloading.ts` calls `profiles.unloadIdle` for a profile no window shows. Only the
  window holding the tab-policy lock runs it (`startLinuxTabPolicies` in `hostPolicies.ts`), and only when the host
  answers the call, so one renderer checks every minute instead of each window racing the others. The host reports
  each tab it closes for the unload as the page's `windowClose`, before its reply, so the shell ignores that event
  for a profile whose `profiles.unloadIdle` call is in flight and for a tab it put to sleep for the unload
  (`closedByUnload`, checked by `pageAskedToClose`); the tabs stay in the sidebar and load again with their history. The host
  (`ac_linux_idle_profiles.cc`, Chrome glue in `ac_linux_idle_profile_engine.cc`) answers `busy` with `heldBy` when a
  tab of that profile has no binding (`tab`) or is visible, in its own window, capturing, in picture in picture or has
  DevTools open; when the profile is the app profile, has a private profile or a download (`profile`, `private`,
  `download`); when a window's own Browser or active profile is it (`window`); when a tab's history can't be kept
  (`history`); or when Chrome's discard policy keeps a page (`page`, its strip's active tab excepted). Otherwise it
  sleeps every tab of the companion Browsers and answers `sleeping` until all are discarded with their history
  saved, then closes each tab keeping its history (`KeepTabHistoryWhenClosed`, no closed-tab entry), closes the empty
  companions, drops the profile's first-window keep-alive and answers `released` (the profile is gone) or `pending`,
  with the unloaded tabs' keys in `tabs`. A profile that isn't loaded answers `released`. Test:
  `engine/ardiacore-linux/tests/test_idle_profiles.py`. When the profile opens again, `tab.create` for a tab of a
  regular profile with no adoption id reads the history the engine kept for its key (`Ardia Tab History/<hex key>`)
  on a background thread and recreates the tab from it when the file is version 1, its URL or virtual URL is the
  tab's (fragment aside) and its generation is the profile's (`ac_tab_history_generation`, else the
  `Ardia Tab History Cleared` marker), as macOS's `RestoreSavedHistory` does; otherwise the URL loads. Private
  profiles, temporary views and user navigations never read it (`ac_linux_saved_history.cc`, Chrome glue in
  `ac_linux_saved_history_engine.cc`). Test: `engine/ardiacore-linux/tests/test_saved_history.py`. As macOS's
  `loadURL:` does, the shell drops the first `loadUrl` of the URL a tab was created with when it comes within 2 s
  (`HostTab.repeatsCreate`), so it doesn't add a second entry after the restored ones.
- **The window's active engine profile.** The Linux shell tells the host which engine profile the window shows
  (`ArdiaShell.setActiveProfile`, sent by `watchActiveProfile` in `hostWindowProfiles.ts` whenever the window's engine
  profile changes, with a sequence number so a late reply can't win). The extension toolbar, popups, side panels and
  extension shortcuts follow it. While the window is active, the member Browser of the active profile is the one
  Chromium sees as active and every other member is told it isn't, the window's own Browser included, as macOS's
  `ActivateExclusively` does; switching back to the window's own profile makes its Browser the last active one again.
  A switch while the window is inactive still tells the member it leaves that it isn't active.
  The sequence belongs to one shell renderer: a reloaded shell starts again from 1, and a profile that resolves after
  the renderer changed is dropped. A switch between profiles that share data leaves all of this unchanged.
- **Extensions per engine profile.** Chromium scopes the extension APIs by profile, so an isolated profile's extensions
  see only that profile's tabs of the window and never the other profile's tabs. Companions are not hidden from
  extensions (`g_ardia_hidden_from_extensions` would also stop tab events, webNavigation and tab lookups for the
  profile's real tabs). A companion's id is the window's id for that profile's extensions, as each profile's Browser
  in a macOS `WindowHost` has its own id. `chrome.windows.update(…, {focused})` on it focuses the visible window, and
  a tab an extension opens in it is offered to the visible window with its engine profile
  (`ArdiaTabs.unclaimed` carries `profile`; `unclaimedTabs.ts` adopts it into a profile of that engine).
- **Closing.** The window's close covers its whole family. After the document seal, each companion's beforeunload
  handlers run (`UnloadController::RunBeforeUnloadForShutdown`, in turn); Stay on any of them cancels the window's
  close and resets every companion, including ones that already said Leave. When the visible Browser closes, each
  companion is closed through Chromium's normal close: a companion that said Leave goes straight to its tabs'
  `unload` handlers, others get a prompt-free beforeunload pass first, and Chromium waits for each tab's unload (or its
  timeout) before the companion goes away. A companion raises no download or multi-tab warning of its own; it is not
  closed with `force_skip_warning_user_on_close`, which would also skip the unload handlers. On quit Chromium's `BrowserCloseManager` drains every Browser,
  companions included. Companions are looked up by id at every use, so a closed one leaves no pointer behind.
  - Chromium's last-window count skips companions, and its `--close-confirmation` multi-tab warning counts the tabs of
    every member, so closing the only visible window asks once, in that window, for the whole family.
  - A companion never reaches `TabRestoreService`: neither its window nor the tabs it closes while closing, on a
    window close or on quit, so the profile's recently closed list never holds a hidden window that would reopen as a
    separate one. Ardia's own closed windows keep every profile's tabs.
- **Downloaded files.** Opening, showing, status and icons of a download accept a path of any profile the window
  shows; a private window still accepts only its own.
- **Private ids.** A private window is `incognito:<window>@<original>`, which resolves to the original profile's
  primary off-the-record profile.
- **Deleting a profile's data.** `profiles.deleteData` takes the engine profile as the call's profile and answers
  `{remaining}`, as on the Mac: an empty list when nothing is left.
  - The default profile answers `["data"]` and a private id answers an empty list; neither is touched. A private
    window gets `ERR_PRIVATE_SERVICE`.
  - A profile that is loaded, loading or still has a private profile answers `["loaded"]` and nothing changes.
    Closing its Browsers, as Chromium's own profile deletion does, would close a visible window whose own Browser is
    that profile, and Chromium itself leaves a loaded profile's files until the next startup. The shell keeps the
    profile in its list of data to delete and asks again at the next launch, before anything loads it.
  - Otherwise the id is marked deleted in `ProfileRegistry` (a later load answers `ERR_PROFILE_DELETED`), its entry
    leaves Chromium's profile list, and Chromium's `NukeProfileFromDisk` removes `<user data>/Profile <id>` and its
    cache folder on the thread pool, retrying as Chromium does. The answer is `["files"]` if the folder is still
    there. Calls for the same profile from several windows share one removal.
- **Private refusals.** These calls are refused for private windows: credentials, history, bookmarks, favicons,
  browsing-data clearing, extension management, sync and live folders. Content-blocker writes are refused too.
- **What private windows can use.** Site settings and zoom apply to the off-the-record session only. Find, Print, Save
  and DevTools work.
- **Session.** Private windows set `omit_from_session_restore`. A private window is visible to other windows only as a
  bare id they can focus.

### Launch configuration

`InitializeLinuxLaunchConfig` (`ac_launch_switches_linux.cc`) is the one place Linux reads the environment.
Command-line switches win over it.

| Variable | Effect |
| --- | --- |
| `ARDIA_BACKGROUND=1` | Becomes the background switch. Background instances never take focus, refuse print, save and DevTools and answer file choosers without a dialog. They never ask polkit. |
| `ARDIA_SWITCHES` | Feature switches. |
| `ARDIA_INSTANCE` | Read for the downloads folder only. |
| `HYPRLAND_INSTANCE_SIGNATURE`, `XDG_RUNTIME_DIR` | Become `--ardia-hyprland-instance` and `--ardia-hyprland-runtime-dir`, the only way the Hyprland socket reaches the PiP code. |
| `ARDIA_CLI_HOME`, `ARDIA_CLI_BIN_DIR`, `ARDIA_CLI_URL` | Passed to the `ardia` command's installer (absolute paths only for the first two). |
| `XDG_DATA_HOME`, `HOME` | Give the default CLI home, `${XDG_DATA_HOME:-$HOME/.local/share}/ardia/cli`. |
| `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_DATA_DIRS`, `HOME`, `PATH` | Give the desktop folders (`LinuxDesktop()`): the autostart folder `${XDG_CONFIG_HOME:-$HOME/.config}/autostart`, the `applications` folders searched for `ardia.desktop` (the user's, then each of `${XDG_DATA_DIRS:-/usr/local/share:/usr/share}`) and the folders searched for `xdg-settings`. Relative entries are dropped. |
| `ARDIA_PACKAGE_DIR` | Only with an explicit `--user-data-dir`: the folder read for `VERSION` and `cli/` instead of the one holding `chrome`. For tests of a raw build tree. |

It also reads `VERSION` beside `chrome` and appends `DevToolsAcceptDebuggingConnections` to `--disable-features`, as
the Mac app does: chrome://inspect's approval mode would replace the process's one DevTools handler, the `ardia`
command's token server.

`ARDIA_DATA_DIR` isn't read: pass `--user-data-dir`. Test hooks and authentication bypasses don't exist in this
build (`SignedForDistribution()` is true and `TestInstance()` false), with one exception: `--ardia-test-cast-sink`,
honoured only by the browser process of an instance started with its own `--user-data-dir`, registers Chromium's
test media route provider (`ac_test_media_route_provider.cc`, `TestFlag("mediaRouteProvider")`), which offers one
fake device, "Ardia Test Sink", and records routes without sending anything anywhere.

## How macOS stays unchanged

- **GN.** Linux sources are behind `is_linux` in `engine/chromium/src/chrome/browser/ardia/BUILD.gn` and in the
  `engine/ardiacore-linux` layer. The Mac layer (`engine/ardiacore`) is selected only for `mac`.
- **Patch series.** Manifest entries are `chromium <patch> [mac|linux|all]` and `layer <dir> [mac|linux|all]`; an
  omitted selector means shared. Apply, capture-base, materialize, files and check all use the same selection.
- **Series bases.** Mac arm64 keeps `series-base`. Other targets use `series-base-<os>-<cpu>`, and recorded platform
  metadata stops one target's base being reused for another.
- **Split patches.** Three patches that mixed shared and Cocoa changes are split:
  - `chromium-window-hosted.patch` keeps the shared last-tab and window lifetime changes, and
    `chromium-window-hosted-mac.patch` carries the Cocoa view behaviour;
  - CEF carryover and Helium branding have shared, `-mac` and `-linux` parts. Duplicate hunks live only in the
    platform part.
  - The Mac series materializes to the same files as before.
- **Shared engine code.** Linux-only behaviour in shared `ac_*` files sits behind `BUILDFLAG(IS_LINUX)`:
  - the wiped secret reply (`Reply::SendSecret`, `SecretUTF8`);
  - card-number reauthentication;
  - the Linux reauth purpose strings.

  The macOS branches are the original lines.
- **Shared UI.** The changes there are seams whose default behaves as before:
  - `platform/windowClose.ts` (`managesWindowClose` returns false unless a platform registers a handler);
  - `platform/livePersistence.ts` (the default writes `live.json` with the same 800 ms debounce as before);
  - `decideWindowClose`/`decideLastTabClose` factored out of `state/windows/windowClose.ts`;
  - test ids on the extension popup.
- **Linux overrides.** Linux replaces shared modules through its own Vite aliases (`apps/linux/vite.config.ts`).
  Its wording transforms (`linuxWording.ts`, `credentialWording.ts`, `syncWording.ts`, `calendarWording.ts`) rewrite
  exact strings at build time and fail the build when a shared string they replace changes. Mac wording can't ship on
  Linux, and the Linux copy can't drift silently.
- **Engine fetch.** `packages/ardiacore/scripts/fetch-engine.sh --arch linux-x86_64` dispatches to
  `scripts/linux/fetch-engine.sh`; without `--arch` the Mac path is unchanged.
- **Proof.** `pnpm --filter @ardia/linux test:graph` asserts that the Linux production module graph loads nothing
  from `packages/demo` and only the Linux adapters it means to.

## Building on Linux

Use a dedicated build root, apart from any Mac Chromium tree. `01-sync.sh` is for a fresh tree and refuses to run
when an output directory exists; after that, builds are incremental.

Provision Chromium's Linux build dependencies first, along with Node 24, pnpm 11, Python 3, Git, util-linux `flock`,
and ImageMagick or Pillow. Helium's Docker build environment is a useful reference.

```bash
export AC_CHROMIUM_BUILD="$HOME/ardia-linux-build"
export AC_TARGET_OS=linux
export AC_TARGET_CPU=x64
export PYTHONDONTWRITEBYTECODE=1
mkdir -p "$AC_CHROMIUM_BUILD"

git clone https://chromium.googlesource.com/chromium/tools/depot_tools.git "$AC_CHROMIUM_BUILD/depot_tools"
git clone --depth 1 --branch 0.22.1 https://github.com/imputnet/helium-chromium.git "$AC_CHROMIUM_BUILD/helium"
git clone --depth 1 --branch 0.22.1.1 https://github.com/imputnet/helium-linux.git "$AC_CHROMIUM_BUILD/helium-linux"
git -C "$AC_CHROMIUM_BUILD/helium" fetch --depth 1 origin "$(sed -n 's/^helium_chromium_commit = //p' engine/patches/build/helium-pins.ini)"

source engine/patches/build/env.sh
scripts/agent/locked chromium -- engine/patches/build/01-sync.sh --apply
scripts/agent/locked chromium -- python3 engine/patches/build/03-helium.py --platform linux --apply
scripts/linux/build.sh --apply --generate
```

- **Pins.** The tags must match `engine/patches/build/helium-pins.ini`. helium-linux's `helium-chromium` submodule
  may sit a few commits past the shared Helium tag; `03-helium.py` accepts that only when the two commits agree on
  everything the build reads (the patches, version files, lists and utils), which is why the `fetch` line brings in
  that commit.
- **Linux preparation.** It bootstraps `depot_tools`'s Python and replaces the Debian sysroot's hard-linked driver
  libraries with private copies (`normalize-sysroot.py`).
- **Build settings.** The build keeps the official configuration: phase-2 PGO, ThinLTO, CFI and the sandbox. The
  output is `out/Release_GN_linux_<cpu>/chrome`.
- **Build time.** A first build takes roughly five hours with six jobs on eight cores and 24 GB of RAM.
- **arm64.** Use `AC_TARGET_CPU=arm64`.

After that, rebuild incrementally (add `--generate` when GN arguments change):

```bash
scripts/linux/build.sh --apply
```

`build.sh` holds the chromium lock and runs `04-series.sh`, `02-gn-args.sh` (with `--generate`) and `05-build.sh`.
To inspect the configuration without touching a tree:

```bash
scripts/linux/build.sh --print-config
python3 engine/patches/series.py files --platform linux
```

## Installing on Linux

Every release with Linux on it, nightlies included, has these assets for x86-64 on its GitHub release page, each with
a `.sha256` file beside it (`sha256sum -c <asset>.sha256` checks a download):

- **Debian 13, Ubuntu 24.04 and later: the `.deb`.**

  ```bash
  sudo apt install ./Ardia-<version>-linux-x64.deb
  ```

  apt pulls in the libraries Ardia needs (NSS, GTK 3, ALSA, CUPS, libsecret, curl and the rest). The package makes
  `chrome-sandbox` setuid root, installs the AppArmor profile Chromium's sandbox needs on Ubuntu, and registers Ardia
  as an `x-www-browser` alternative. A newer `.deb` installs over an older one, and a nightly's version
  (`0.2.47~nightly.3`) sorts before its stable, so `apt install` of the stable upgrades it. `sudo apt remove ardia`
  removes it and `sudo apt purge ardia` leaves nothing behind outside your home folder, where your profile
  (`~/.config/ardia`) and the `ardia` command, if you turned it on (`~/.local/share/ardia`), stay.
- **Arch: `ardia-bin`.** Once the package is on the AUR, which follows stable releases:

  ```bash
  yay -S ardia-bin
  ```

  Without the AUR, or for a nightly, build it from the release's Arch source package. It holds the PKGBUILD and
  `.SRCINFO` pinned to that release's tarball, which makepkg downloads and checks against its sha256:

  ```bash
  tar xf ardia-bin-<version>.src.tar.gz
  cd ardia-bin
  makepkg -si
  ```

  `sudo pacman -R ardia-bin` removes it.
- **Any distribution, no install: the AppImage.**

  ```bash
  chmod +x Ardia-<version>-linux-x64.AppImage
  ./Ardia-<version>-linux-x64.AppImage
  ```

  It needs unprivileged user namespaces, which Ubuntu 24.04 and later restrict: there it refuses to start and says
  so; use the `.deb`.
- **Any distribution: the tarball.**

  ```bash
  tar xf Ardia-<version>-linux-x64.tar.xz
  sudo ./ardia/install.sh
  ```

  It installs under `/usr` (or `--prefix`), and no package manager knows about it: install the libraries yourself, and
  to remove it run `sudo /usr/lib/ardia/install.sh --uninstall` (or `sudo ./ardia/install.sh --uninstall` from the
  extracted package), with the same `--prefix` if you used one (see Uninstalling below).

## Packaging and installing

```bash
pnpm install --frozen-lockfile
pnpm --filter @ardia/linux build
source engine/patches/build/env.sh
python3 scripts/linux/package.py \
  --out "$CB/chromium_git/chromium/src/out/$GN_OUT_CONFIGS" \
  --ui apps/linux/dist \
  --content-blocker "$(scripts/linux/fetch-ubo.sh)" \
  --destination "$CB/artifacts/ardia-linux-$AC_TARGET_CPU.tar.xz"
```

- **Formats.** `--deb <path>` and `--appimage <path>` build a `.deb` and an AppImage from the same tree. `release.sh`
  builds all three and smoke-tests each.
- **Launcher.** Every format starts through `lib/ardia/ardia-launch`, which decides the sandbox before it runs
  `chrome`: user namespaces when the kernel allows them and AppArmor doesn't restrict them (or a profile grants
  `userns` to this `chrome`), else the setuid-root `chrome-sandbox` beside it on a mount without `nosuid`. Otherwise it
  says why on stderr and exits 1, whatever the format: Ardia never runs without the sandbox on its own. A tarball run
  in place points at `sudo install.sh` or the `.deb`; an AppImage points at the `.deb` (the sandbox helper and the
  AppArmor profile) or at the `sysctl` that allows user namespaces for the reason it found. Only a user who passes
  `--no-sandbox` runs without it: the launcher adds `--ardia-sandbox-decision=Ardia was started with --no-sandbox`, and
  the shell says so once per launch and counts `launches_without_sandbox`.
- **`.deb`.** Installs under `/usr` (`/usr/bin/ardia` links the launcher), with `chrome-sandbox` setuid root, the
  polkit policy and the AppArmor profile; details under Debian package below.
- **AppImage.** AppImage's static type 2 runtime and `mksquashfs` (zstd) from a toolset pinned by SHA-256, cached in
  `~/.cache/ardia-appimage`. It carries no setuid helper and no polkit policy, so reauth falls back to the login
  password, and it needs user namespaces: where they're restricted (Ubuntu 24.04 and later) it refuses to start.

That makes a dev package. A release adds `--version <version>` and `--cli <ardia-cli-<version>-linux-x64.tar.gz>`, the
pinned command renamed for this version (`scripts/release/official-plugins.py linux-cli <version> <out>`).
`scripts/linux/release.sh <version>` runs the whole release build, the smoke gate included, and prints the upload
command ([linux-ci.md](linux-ci.md) › Linux releases).

- **Version and CLI.** `--version` must match `<major>.<minor>.<patch>` or `<major>.<minor>.<patch>-<channel>.<n>`, and
  `--cli` needs it. package.py checks the CLI tarball before copying it:
  - its name must carry the same version and `linux-x64`;
  - its `.sha256` file, when one sits next to it, must match;
  - every entry must sit under `ardia-cli-<version>/`, including `bin/ardia`.
- **Content blocker.** `fetch-ubo.sh` prepares the same pinned, patched uBlock Origin build macOS embeds, by running
  `packages/ardiacore/scripts/ubo.sh` with `flock` and `sha256sum` standing in for `lockf` and `shasum`. Without
  `--content-blocker` the package has no blocker, and Settings says so.
- **Seeded blocker.** With a blocker, package.py runs `scripts/linux/ubo-seed.mjs` on its staged copy (skip it with
  `--no-ubo-seed`). The script starts the staged `chrome` once on a scratch profile in English, waits for uBlock
  Origin to fetch and compile its default lists and save its engine, and writes that storage to
  `extensions/ublock/ardia-seed/storage.json`, without the raw and compiled list copies uBlock Origin can rebuild. It
  also patches the staged `js/start.js` to load the seed first thing into a profile whose uBlock Origin storage is
  empty, when the seed's uBlock Origin version is the running one and the profile's languages select no regional list
  the seed lacks (otherwise uBlock Origin compiles its own lists, as before). A seeded profile skips uBlock Origin's
  first-install restart and list compile and loads the saved engine. Packaging takes about a minute longer.
- **Modes.** package.py sets every directory and executable to 0755 and every other file to 0644 before archiving,
  so a package built under a umask of 002, Ubuntu's default, matches one built under 022.
- **Compression.** package.py streams the tar through `xz -T0 -6`, every core at once.
- **Archive contents.**
  - `bin/ardia`;
  - `lib/ardia/chrome` and the Chromium runtime files from the allowlist in `scripts/linux/runtime_files.py`;
  - `lib/ardia/ardia-ui`;
  - `lib/ardia/extensions/ublock`;
  - `lib/ardia/VERSION` (with `--version`), one line with the Ardia version (`0.2.44`, `0.2.44-nightly.3`);
  - `lib/ardia/cli/` (with `--cli`): `ardia-cli-install.sh` (`apps/cli/install.sh`, the pinned installer from
    ardia-browser/plugins; `scripts/release/official-plugins.py check` holds it to the pin, mode 0755),
    `ardia-cli-<version>-linux-x64.tar.gz` and `ardia-cli.sha256` (the digest is its first token), the `ardia`
    command's installer, tarball and pinned digest. When the CLI is turned on, the browser installs from these files
    with `ardia-cli-install.sh --version <VERSION> --sha256 <digest>` and `ARDIA_CLI_URL=file://…`;
  - the desktop entry and icon;
  - `share/polkit-1/actions/dev.ardia.linux.policy`;
  - `share/apparmor.d/ardia`, the AppArmor profile `install.sh` installs on Ubuntu;
  - `install.sh`.
- **Running it.** Run the extracted `bin/ardia`. A raw build-tree `chrome` needs `--ardia-ui-dir apps/linux/dist`.
  Test with a throwaway `--user-data-dir` and keep the sandbox on.
- **Installing.** `sudo ./ardia/install.sh` installs under `/usr`. It also accepts `--prefix /opt/ardia` and
  `--destdir <staging root>`.
  - Without `--destdir` it must run as root and refuses otherwise, so it never leaves a partial install. Installed
    files are owned by root.
  - It copies `lib/ardia` whole, so `VERSION` and `cli/` come along.
  - It always installs the polkit policy at `<destdir>/usr/share/polkit-1/actions` (mode 0644), whatever the prefix,
    because polkit reads actions only from there. Without the policy Ardia can't ask for the system password, so saved
    passwords and card numbers stay hidden.
  - Without `--destdir` it also keeps a copy of itself at `<prefix>/lib/ardia/install.sh` and adds the prefix to
    `/var/lib/ardia/installs`. A prefix is made canonical first (`realpath -ms`), so `//opt/./ardia/` installs as
    `/opt/ardia`. Installs and uninstalls without `--destdir` run one at a time (`flock` on `/var/lib/ardia/lock`).
- **Debian package.** `package.py --deb <path> --version <version>` (`scripts/linux/linux_formats.py`) builds it from
  the staged tree with `dpkg-deb`, so it needs `dpkg-deb` and `readelf` (`apt install dpkg binutils`, Arch:
  `pacman -S dpkg binutils`):
  - `/usr/lib/ardia` is the tarball's `lib/ardia`, with `/usr/bin/ardia` a link to its launcher, the desktop entry
    pointed at `/usr/bin/ardia`, the AppArmor profile at `/usr/share/ardia/apparmor/ardia` and
    `/usr/share/doc/ardia` (copyright, changelog). `DEBIAN/md5sums` lists every file;
  - its version is the Ardia version with `-` turned into `~` (`0.2.47~nightly.3`), so a nightly sorts before its
    stable. A `.deb` needs `--version`;
  - `Depends` comes from the binaries: every `NEEDED` library of the ELF files in `lib/ardia` (the Qt shims excepted:
    Chromium loads them only on Qt desktops) maps to its Debian package with the 64-bit-time name first
    (`libasound2t64 | libasound2`), `libc6`'s minimum is the highest `GLIBC_` symbol version, and the list adds what
    Chromium loads at run time (GTK 3, libsecret, Liberation fonts, xdg-utils) and `curl`, which the bundled CLI
    installer downloads with. A library with no package in `SONAME_PACKAGES` fails the build, so a new engine
    dependency can't ship unnoticed. polkit and Vulkan are `Recommends`;
  - it `Provides: www-browser`; `postinst` makes `chrome-sandbox` setuid root, copies the AppArmor profile to
    `/etc/apparmor.d/ardia` and loads it where `/etc/apparmor.d/abi/4.0` exists, as `install.sh` does, and registers
    `/usr/bin/ardia` as the `x-www-browser` and `gnome-www-browser` alternative (priority 100), also on dpkg's
    `abort-remove`, `abort-deconfigure` and `abort-upgrade` rollbacks; `prerm` unregisters it only on `remove`, so a
    deconfigure that dpkg rolls back keeps an admin's choice, and `postrm` unloads and deletes the profile (and its cache) on remove and purge.

  `scripts/linux/deb-install-test.sh <deb>` installs it with apt in `debian:13` and `ubuntu:24.04` containers (Ubuntu
  with the apparmor package): the dependencies resolve, `ldd` finds every library, `ardia --version` runs,
  `chrome-sandbox` is setuid root, the browser alternatives and `curl` are there, the profile appears only with the
  4.0 ABI, and `apt purge` leaves the file system as it was before the install. apt retries each download and each
  image pull is retried, so a network flake doesn't fail it.
- **Arch.** `scripts/linux/arch/PKGBUILD` is the AUR package `ardia-bin`: it downloads
  `Ardia-<version>-linux-x64.tar.xz` from the `v<version>` release, checks its pinned sha256 and installs it with the
  tarball's `install.sh`, then makes `chrome-sandbox` setuid root, as Arch's own `chromium` does, for kernels without
  unprivileged user namespaces. `scripts/linux/arch/update-pkgbuild.sh <version> --package <tarball>` (or `--sha256`) sets
  `pkgver` (`0.2.47-nightly.3` becomes `0.2.47nightly.3`, which pacman sorts before `0.2.47`), resets `pkgrel` and writes the matching `.SRCINFO` without makepkg;
  `update-pkgbuild.sh --check` fails when the committed `.SRCINFO` drifts from the PKGBUILD. The committed pair
  pins the 0.2.47-nightly.2 test build this was verified with; the AUR copy moves with each stable release.
  `scripts/linux/arch/publish-aur.sh <version> --sha256 <digest>` clones `ssh://aur@aur.archlinux.org/ardia-bin.git`
  (host keys pinned in `aur_known_hosts`), refuses to go back a version (a nightly counts as older than its stable), checks that the release's tarball has the
  digest, commits and pushes; `--dry-run` clones over HTTPS and pushes nothing. The Release workflow runs it after
  each stable release ([linux-ci.md](linux-ci.md) › The AUR).
  `release.sh` also packs the PKGBUILD and `.SRCINFO` it pins to the release's tarball into
  `ardia-bin-<version>.src.tar.gz` (a folder `ardia-bin/`), which every release carries, nightlies included.
  To try a local tarball, write the pair with `update-pkgbuild.sh <version> --package <tarball> --out <folder>`, put
  the tarball beside them renamed `ardia-bin-<pkgver>.tar.xz` (makepkg then skips the download), and run
  `makepkg -si`. `pkaction --action-id dev.ardia.linux.reauthenticate` then lists the polkit action.
- **Uninstalling.** `sudo /usr/lib/ardia/install.sh --uninstall` (or the extracted package's `install.sh --uninstall`,
  with the same `--prefix`, and the same `--destdir` for a staged tree) removes what the install put down: `lib/ardia`, the launcher and the desktop entry and
  icon when they're Ardia's for that prefix, the AppArmor profile when its attachment is exactly that prefix's `chrome`
  (unloaded first), and the polkit policy unless a package owns it, `/usr/lib/ardia` still holds an Ardia, or another
  prefix in `/var/lib/ardia/installs` still does. It refuses a prefix
  with no Ardia in it, and an Ardia a `.deb`, Arch or RPM package installed, also when the prefix reaches it through a symlink (remove that
  with its package manager).
  Each user's profile in `~/.config/ardia` stays. Two tarball installs share one AppArmor profile, so the last
  install's prefix owns it. `scripts/linux/install.test.mjs` covers the staged round trip.
- **Ubuntu.** On a host whose AppArmor reads the 4.0 ABI (`/etc/apparmor.d/abi/4.0`, Ubuntu 24.04 and later), an
  install without `--destdir` also writes `/etc/apparmor.d/ardia` and loads it with `apparmor_parser -r`. The profile
  leaves `<prefix>/lib/ardia/chrome` unconfined and allows it user namespaces, which Ubuntu denies to unprivileged
  programs and Chromium's sandbox needs. A staged install writes no profile, and an older AppArmor never gets the
  file, which it couldn't parse.

CI builds packages from a prebuilt engine instead of compiling Chromium; see [linux-ci.md](linux-ci.md).

## Tests

These checks need no Chromium tree. `scripts/linux/ci-checks.sh` runs all of them:

```bash
pnpm --filter @ardia/linux typecheck
pnpm --filter @ardia/linux test:host
pnpm --filter @ardia/linux test:symbols
pnpm --filter @ardia/linux test:graph
pnpm --filter @ardia/linux acceptance:self-test
pnpm --filter @ardia/linux build
python3 -m unittest discover -s engine/patches/build/tests
python3 -m unittest discover -s engine/chromium/src/chrome/browser/ardia/tests
python3 -m unittest discover -s engine/ardiacore-linux/tests
node --test engine/ardiacore-linux/tests/bootstrap.test.mjs
node --test scripts/linux/install.test.mjs
```

- **Patch tooling tests.** These cover platform selection, separate bases, repeat application, materialization,
  drift and package layout.
- **Engine fixtures.** These compile the real Linux services against stub Chromium interfaces, under ASan and UBSan
  where they parse input. Examples:
  - the dispatcher;
  - credential routing and secret wiping;
  - polkit replies;
  - site controls and the blocker queue;
  - Live folders against fake providers;
  - the EDS calendar client against a fake EDS on a real `dbus-daemon`;
  - sync against macOS-produced vectors.
- **Host tests.** These drive the shared UI through the Linux adapters and the real bootstrap transport, against a
  simulated native host.

Against a built package:

```bash
node scripts/linux/smoke.mjs --package <ardia-linux-x64.tar.xz> --results <dir>
pnpm --filter @ardia/linux acceptance -- <extracted>/ardia/bin/ardia
```

- **Smoke gate.** Twelve checks: libraries resolve; the shell renders the packaged UI; the bootstrap reports
  `linux-host`; a native tab paints and can't see the bridge; renderers run under seccomp; the blocker loads; a restart restores the tab; `install.sh --destdir`
  stages correctly; and, for a release package, the app version, the bundled CLI install, `ardia` control, and a
  userscript installed with `ardia scripts install` running on the fixture page ([linux-ci.md](linux-ci.md) › Smoke gate).
- **Acceptance suite.** Nine headless scenarios for core features; see [linux-acceptance.md](linux-acceptance.md).
- **Shared changes.** A change to shared code also needs the Mac checks.

### Updates and kill switches

- **Check.** With an engine that serves `ArdiaUpdates.releases`, Settings › General shows Updates. The host reads
  GitHub's release list for ardia-browser/ardia (`ac_linux_updates.cc`: a cookieless GET of a fixed URL, at most
  4 MiB, no redirects, 20 s), and the shell (`hostUpdates.ts`, `updateReleases.ts`) keeps published releases that
  carry a Linux package and a github.com release page, newest per channel (a nightly build follows nightly).
- **What it does.** Check Now and the app menu ask before opening the release page; an automatic check (30 s after
  launch, then every 6 h, in one window, never in a hidden instance or a build without `lib/ardia/VERSION`) offers a
  newer release once as a toast. Ardia doesn't install updates on Linux, so "Automatically update Ardia" is hidden.
- **Kill switches.** `ArdiaShell.fetchKillSwitches` fetches `ardia.dev/switches.json` (at most 16 KiB) once per
  browser process for every window, and the shared refresh runs under the Mac's rule (automatic checks on).
- **Telemetry.** `update_checks_asked`, `update_checks_automatic`, `update_check_failures`, `update_checks_found`,
  `update_release_page_opens`, `kill_switch_refreshes`, `kill_switch_refresh_failures`.

### System signals and location

- **Idle, sleep and wake.** `ArdiaSystemSignals.watchIdle` and `onSystemSignal` are served
  (`ac_linux_system_signals.cc`): sleep and wake from logind's `PrepareForSleep`, idle from Chromium's own idle time
  (`ui::CalculateIdleTime`), polled only while a window watches a threshold. Automation's `user.idle`, `user.active`,
  sleep and wake hooks fire.
- **Location.** Sites get positions from GeoClue 2 (`ac_linux_geoclue.cc`, hooked into
  `OverrideSystemLocationProvider` by `chromium-linux-geolocation.patch`): desktop id `ardia`, exact accuracy for
  high-accuracy requests and city level otherwise. Without GeoClue or a fix within 10 s a page gets "position
  unavailable". `ArdiaLocation.locationPermission` answers `servicesOff` when the desktop refuses Ardia.

## Platform notes

### Windows, focus and input

- **Window controls.** Linux uses the Windows build's caption buttons on the right: `…`, minimize, maximize (restore
  while maximized) and close, drawn by the shared `WindowControls.tsx` in the places Windows puts them (the toolbar
  row, the end of the top strip, a right sidebar's header, atop a left sidebar with the address bar in it, Little
  Ardia's bar, Settings and Import). There are no traffic lights. They work on decorationless desktops such as
  Hyprland; Chrome's own caption buttons are hidden: opacity 0, no input, ignored by accessibility.
  - `lib/platformChrome.linux.ts` takes the Windows `WINDOW_CHROME`. `platform/windowControls.ts` is swapped for
    `hostWindowControls.ts`: minimize and maximize call `ArdiaShell.minimizeWindow` and `toggleMaximizeWindow`, and
    caption regions are a no-op because the shell's own drag regions move the window. Close goes straight to the
    shell's close coordinator (`captionControls.ts`, swapped in for `WindowControls.tsx`'s close), so a window with
    tabs to lose asks once, not first in the shared path and again in the coordinator.
  - `WindowControls.tsx` wraps the shared one: right-clicking the buttons opens the window menu (`linuxWindowMenu.ts`)
    except in Settings and Import, and the buttons hide while a page is in full screen.
  - The `…` opens the Linux app menu (Menu button below) under itself (`clusterAppMenu.ts`, swapped in for
    `BrowserWindowControls.tsx`'s `showAppMenu`): a pointer press anchors it to the pressed `…`, a key to the focused
    one, and an activation with neither (assistive technology) to the visible one. Pressing it, or Enter on it, while
    a menu is open closes the menu. The buttons take keyboard focus like any button (`focusable` on the shared
    `ControlButton`), and the `…` counts as a menu surface, so tabbing to it keeps the field Edit › Copy and Paste act
    on. There are never two menu buttons: the `…` while the window buttons are drawn, the header's hamburger
    otherwise (window or page full screen). Linux keeps the sidebar header the Windows rule would collapse whenever
    the hamburger has no other home (`sidebarHeaderLayout.ts`). Some full-screen layouts still have none, as before
    this change: top tabs with minimalism, or a sidebar whose profile part is hidden.
  - Restore: the engine sends no `maximized` event, so each window reads `ArdiaShell.windowFrame` at start and once
    per animation frame of resizing, and marks itself maximized when the frame fills the work area, feeding the shared
    `useMaximizedWindows` through `captionRegions.ts`'s `noteMaximized` (`windowMaximized.ts`). Settings and Import
    too. Known limits: a window that fills the work area without being maximized, such as a lone tiled window on a
    tiling window manager (X11 or Wayland), shows restore. On Wayland `windowFrame` is null and the work area is the
    whole output, so the shell compares its outer size with that, and with a panel, a bar or gaps a maximized window
    keeps the maximize glyph. Clicking still toggles correctly; the glyph needs the engine to report maximized state.
- **Header drag and double-click.** Dragging the header moves the window (`DispatchHostWindowDragMovement`).
  Double-clicking it runs the desktop's titlebar action.
- **Outer frame.** The host overlays Chromium's client view and doesn't replace its frame. Without the Wayland
  decoration protocol, Chromium draws its custom frame.
- **Menu button.** Linux has no global menu bar, so a menu button stands in for the Mac one: usually the `…` beside the
  window buttons, and a hamburger in the header only while they're hidden (Window controls above). It lists Ardia,
  File, Edit, View, Tabs, Bookmarks, History, Extensions, Window and Help as submenus built from the same menu
  state the Mac menu bar uses (checks, disabled commands, dynamic titles, bookmarks, recently closed entries, profiles
  and extensions), labelled with the effective Linux shortcuts (`apps/linux/src/appMenu.ts`). Items run through the
  shared command path; Close Window, Minimize and Maximize call the native window operations. App commands Linux runs
  itself (`LINUX_APP_COMMANDS` in `appServices.ts`) are kept from the shared handler so they run once. Mac-only entries
  (Services, Hide, Spelling, Substitutions, Speech, Transformations, the WebKit page engine, JavaScript from Apple
  Events, Keep on Top, Delete and the spelling selectors) are left out.
  - **View › Enter Full Screen** (`std:toggleFullScreen:`, F11, remappable in Keyboard Shortcuts) sits where the Mac
    has it, reads Exit Full Screen while the window is full screen and calls `ArdiaShell.toggleFullScreen`. The
    entry, its shortcut and its Keyboard Shortcuts row exist only when the host advertises that call; until then F11
    is left to Chromium.
  - **Edit › Undo, Redo, Cut, Copy, Paste, Paste and Match Style, Select All**, in the Mac's order around Copy URL
    (`editCommands.ts`, `editTargets.ts`). They act on what had focus before the menu took it: a shell text field is
    edited with `document.execCommand` (a paste the engine refuses falls back to the clipboard's text), with Cut and
    Copy off without a selection; otherwise the window's page gets `tab.command` `edit`, which needs the host's
    `tab.edit`. With neither a field nor an editable page the entries are left out. Their shortcuts are Chromium's
    own and aren't registered or remappable.
  - **Paste and Go** and the address bar's paste read the clipboard through the host's `ArdiaShell.readText`
    (`ui::Clipboard`, plain text from the copy and paste buffer, as the Mac reads `NSPasteboard`). An older engine
    without it leaves the shell's `navigator.clipboard.readText()`, which answers empty in `chrome://ardia`.
  - **Back and forward swipes over a page.** A two-finger horizontal touchpad scroll the page doesn't consume
    (`ac_linux_page_swipe.h`, from the page channel's gesture acks) is sent to the shell as
    `ArdiaShell`/`onPageSwipe` and drives the same swipe overlay as a swipe over the shell
    (`shims/web/motion/swipe.ts`). Chromium's own overscroll navigation is off in every bound tab. A swipe the page
    starts by scrolling stays with the page, and the momentum after the fingers lift ends the swipe. Untested on
    real touchpad hardware.
- **Report a Problem.** Help › Report a Problem… (and the New Tab check-in, the command bar and automation) goes
  through `reportProblem.ts`, swapped in for the shared report actions under `appCommands.ts`. It decides when the
  command runs:
  - With an engine that advertises both `report.files` and `report.send` it opens the Mac's report sheet (Problem
    reports below).
  - Otherwise, or when the host sets a `feedbackURL` with `%s`, it opens a new issue in a tab (GitHub's, or that
    page), its body a short template and Copy Diagnostics' report. The shell's `connect-src 'none'` stops the sheet's
    own post, and `ArdiaReport` answers unavailable or empty values (`appModuleFallbacks.ts`).
- **Favicon accents.** `ArdiaDockSelection.iconAccent` (the command bar's scope pulse) runs in the shell: a port of
  the Mac's dominant-hue pick over a 32 px canvas copy of a `data:` or `blob:` favicon (`iconAccent.ts`). Other URLs
  answer no accent.
- **Settings and Import.** Each opens in its own utility window and reuses an open one. Settings
  opens from Ardia › Settings… in the menu or Ctrl+comma.
  - Settings starts at 820×640 with a 720×480 minimum.
  - Import starts at 640×600 and doesn't resize.
  - They never create browser tabs or windows. A utility close waits for its pending session writes.
  - Closing the last browser window closes them too, so Ardia quits instead of living on behind a lone Settings
    window.
- **Shortcuts.**
  - Linux owns its shortcut catalog (`apps/linux/src/commandCatalog.ts`, `shortcuts.ts`). The same effective bindings
    fill Settings › Keyboard Shortcuts and drive the native key handler at the window's Aura root, so a focused page
    and the shell dispatch the same commands.
  - Bindings match physical key codes, with a logical fallback, so layouts such as German don't remap Ctrl+Z.
  - A modal dialog keeps its keys.
  - A menu item's alternate swaps in while its own extra modifier is held, as in an AppKit menu: Alt for a ⌥
    alternate (Copy Links → Copy Links as Markdown in the tab and multi-tab menus), Ctrl for a ⌘ one (a profile's
    New Window entry).
  - Quit is Ctrl+Shift+Q. Ctrl+Tab commits on release of the physical Control key.
  - `--ardia-keyboard-diagnostics` with `--enable-logging=stderr` logs each key, its binding and the focused view.
- **Ctrl-scroll zoom.** Chromium zooms a tab when a page leaves a Ctrl-wheel event unhandled
  (`BrowserWebContentsDelegate::ContentsZoomChange`). `chromium-linux-wheel-zoom.patch` puts one gate there,
  `g_ardia_linux_wheel_zoom_off`, and `webView.setCommandScrollZoom {enabled}` sets it for every window and profile
  (`SetLinuxPageOption`), so Settings › Privacy › Zoom works. The host advertises the call.
- **Typeahead.** Keys typed before a new window's UI is ready are held and replayed into the focused text field. The
  hold takes at most 512 events and lasts at most 10 s.
- **Wayland placement.** Wayland gives clients no global window position. `windowFrame` returns null there, only
  sizes are saved, and the compositor places windows.
- **Wayland focus.** Activation uses `xdg_activation_v1` and the compositor may refuse it (Hyprland may mark the
  window urgent instead). A Wayland client can't refuse focus when it maps, so `ARDIA_BACKGROUND=1` keeps focus only on
  X11.
- **Sidebar-edge peek** (#368). With the sidebar hidden, the native host watches the sidebar's edge itself
  (`ArdiaShell.watchSidebarEdge`, `ac_linux_sidebar_edge.h`), the way macOS's `SidebarEdgeWatcher` does: the left edge,
  or the right edge when Settings › Tabs › Sidebar position is Right. Before this the shell watched its own DOM. The native page covers everything from the card's 9 px inset, and the frame's resize border
  never reaches the shell, so only window x 4–10 revealed the sidebar on X11. No fast move ever revealed it (0 of
  15), and moving into the sliding panel re-hid it in 2 of 3 runs, because the pointer reached the page before the
  panel's cut-out did. A handler at the window's Aura root now sees every pointer event, over the page and the frame
  too.
  - The zone is 8 px from the client's edge, plus anything of the window beyond it (the resize border), up to
    24 px. The right edge mirrors the left pixel for pixel.
  - While the peek is out, the pointer counts as over anywhere in its column, 5 + sidebar width + 24 px wide, over the
    page too. Dismissal keeps the shared 120 ms delay.
  - Wayland has no global pointer, so the 24 pt reach macOS gives outside the window becomes this: when the pointer
    leaves through the sidebar's edge of the active window, the peek opens after 90 ms. If focus moves first
    (Hyprland's `follow_mouse` focusing the neighbouring window), it doesn't open. A peek that is already out stays out
    while the pointer is just past the edge, and closes when the window loses focus.
  - A peek that is out also stays out when the pointer leaves through the top or bottom over its column, up to 24 px
    past the window, as macOS's watcher allows while holding. On wlroots the pointer rests in the panel gap above the
    window, and treating that exit as leaving made the strip flicker at the top corner. Leaving through the top corner
    never reveals a hidden strip.
  - Switching the sidebar's side re-evaluates the last pointer position and drops a pending 90 ms settle.
  - No screen-edge crossing watch. macOS lets the pointer cross a screen edge another display shares, peeks when it comes
    straight back, and reports `screenEdge` (`crossed`, `returned`) for its telemetry. Linux peeks when the pointer leaves the
    window on the sidebar side, so a fast pointer that crosses to the other display still opens it; a Wayland client
    can't warp the pointer or know its global position anyway. The engine never sends `screenEdge`
    (`shellMethods.test.mjs`), so `sidebar_screen_edge_crossings` and `sidebar_screen_edge_returns` stay macOS only.
  - The watch takes the shared arguments (window id, on, hold, right, whilePressed) and reports the shared
    `sidebarEdge` window event, so the shared UI calls it directly. As on macOS, while a mouse button is held the
    edge isn't over unless the watch passed `whilePressed` (the shared UI passes it while the peek is held or a tab
    is dragged): a drag that crosses the edge doesn't reveal the sidebar, a held peek closes, and a pointer that
    leaves the window with a button down doesn't start the 90 ms settle. The buttons are read from each event; a
    release no longer counts its own button.
  - Older engines: one with only `ArdiaShell.watchLeftEdge` keeps the native watcher for a left sidebar and the
    shell-side watcher (`shims/web/motion/sidebarEdge.ts`) for a right one; its `leftEdge` events are renamed to
    `sidebarEdge`. An engine with neither uses the shell-side watcher on both sides.
- **Top-strip peek.** With Auto-hide tabs in the top-strip layout, the strip's hover zone and its peeked panel are a
  page overlay region (`TopStripPeekRegion.tsx`, swapped in for `App.tsx`'s import), so the host gives the shell the
  pointer where they cover a page: 2 px of the panel with the default toolbar, 15 px with the compact one. While the strip
  is hidden the window buttons and the `…` sit at the end of the toolbar row, as on Windows.
- **Toolbar peek.** With Hide toolbar while scrolling, the toolbar is a page overlay region while it peeks or shows
  (`AutoHideToolbarRegion.tsx`, swapped in for `TabPane.tsx`'s and `WindowToolbar.tsx`'s imports), not while it is
  collapsed. A peek lays the toolbar over the page's top edge, and without the region `plainViewport`'s top samples
  hit it and the page stopped drawing until the toolbar collapsed (#2390). `usage_counts.toolbar_peeks` counts peeks
  and `toolbar_peek_page_hides` counts a page that stopped drawing while its toolbar peeked; it should stay near 0. Both
  count in the telemetry leader window only, like `toolbar_scroll_hides`, so their ratio holds.
- **Sidebar peek.** The peeking sidebar is a page overlay region (`SidebarPeekMark.tsx`), reaching past the panel's
  edge over the half of the resize handle that sticks out. Its dock's outer box takes no hits itself (`box-none`): on a
  peek's first frame that box already sits over the page's edge while the panel is still off screen, and
  `plainViewport`'s samples hit it and hid the page for a frame, a white flash on every peek (#2736); the handle's
  overhang did the same on a frame where it crossed a sample. `usage_counts.sidebar_peek_page_hides` counts a page that
  stopped drawing while the sidebar peeked, in every window like `sidebar_peeks`; it should stay near 0 against it.
  It reads the same peek state that mounts the region, which is set in an effect after the commit that places the
  panel, so a hide in a frame between the two goes uncounted.
- **Header.** The menu button shows here whenever the window buttons are hidden (full screen); otherwise it is the
  `…` beside them. The profile name beside it follows the Mac's rule
  (`ProfileIndicator.tsx`): only in an Incognito window or with two or more profiles, cut when at least 52 px of it
  fit, a person icon below that, and nothing when not even the icon fits (a 190 px sidebar with the Downloads button).
  With the address bar in the sidebar the header holds no profile name, as on the Mac: the toggle at the left, back,
  forward and reload at the right edge, and in full screen the menu button in reload's slot with the three one pitch
  left of it.
- **Materials.** `VisualEffect`, `GlassEffect`, popover bubbles and the window's vibrancy take light or dark from the
  theme scope they render in (`useSurfaceDark`), not the app appearance, so an Incognito window is dark in a light
  app and a toast is light there.
- **Window controls with the sidebar on the right.** They sit in the right sidebar's header, at its outer edge, as on
  Windows.
- **Fullscreen restore.** A window saved fullscreen comes back fullscreen. On Wayland the saved output's name is kept
  in the profile pref `browser.app_window_placement.ArdiaLinuxWindowOutputs`. When exactly one display carries that
  name, the window goes fullscreen there.

### Picture in Picture and Hyprland placement

- **Automatic PiP.** Linux forwards the Tabs setting to Chromium's browser-initiated automatic PiP.
  - Explicit site blocks win, and the global setting off disables it even for allowed sites.
  - Returning to the source or turning the setting off closes the player without pausing.
  - Dismissing it uses up the departure; another visit and departure are needed to open it again.
  - Private windows never enter it.
  - Chromium keeps audio focus, URL safety, permissions and the single PiP owner.
- **Automatic PiP plays inside the window.** When a playing tab goes to the background (a tab switch, Ctrl+T, a new
  tab), its video keeps playing in a floating player drawn inside Ardia's window, over the content card. It never
  maps a toplevel: a Wayland compositor focuses every new toplevel and gives clients no portable way to refuse, so
  Chromium's inactive PiP window used to take the keyboard from the new tab's field. X11 plays it the same way.
  - Engine (`ac_linux_pip_player.{h,cc}`, hooks in `chromium-linux-pip-in-window.patch`): every video PiP window on
    Linux is a `Player`, the controller's `VideoOverlayWindow`. Each session start decides where it plays: in the
    window when the request is automatic (the auto-PiP hook records the intent), otherwise in Chromium's real,
    Dia-styled window (a page's own PiP button, Ardia's PiP command, site controls). The video is a `PlayerView`
    (`LAYER_SURFACE`, 6 pt corners) above the page views and below the shell; it takes no input, and the host keeps
    its rectangle out of the shell's page pass-through.
  - An automatic request with nowhere to play (the window hidden or minimized, its shell not attached, a site set to
    Ask) is declined before the page is asked.
  - Leaving a tab tells Chromium's automatic PiP only once the page is hidden (its `WebContents` no longer
    visible, then the next task), or after `kHiddenPageWaitMs` regardless, as the Mac does since #1793: Meet opens
    PiP only from a hidden page. Coming back before then cancels the departure.
  - Automatic document PiP (video calls such as Meet) opens Chromium's real document PiP window. It maps a toplevel,
    so on Wayland it takes focus as any new window does there. Not yet run against a real Meet call.
  - A PiP that opens reports `fullScreenSpaces: false` and `leftTab` (its tab wasn't shown), so the shared
    `pip_shown` count, which needs `fullScreenSpaces`, now counts Linux too, with `left_tab`.
  - Shell (`InWindowPlayer.tsx`, `pipPlayer.ts`, `pipGeometry.ts`): Dia's PiP controls and timings (the hover scrim,
    back to tab, close, play/pause, ±10 s, the progress bar), plus a pop-out button. A click that travels under
    3 px on the video's left or right side skips back or ahead 10 s through the same `seekBy` command, as on the Mac;
    the play button's column (40 px either side of the centre) does nothing, and each click of a double click skips
    again (`usage_counts.pip_click_skips_back` and `pip_click_skips_ahead`). Drags move it inside the
    content card, a fling throws it to a corner with Dia's spring, the edges resize it at the video's aspect, and
    its corner, offset and width are remembered in `pip-player.json`. Its messages carry the player's generation, so
    a late reply can't move or close a newer player.
  - Layering, bottom to top: the page, the player's video, the base shell UI clipped around the player, then the
    shell's overlays. `playerHoles.ts` clips each base subtree under the player that holds no overlay; the
    background of an element that does hold overlays is holed by `pageHoles` (`setFloating`, a floating hole merged
    with the page holes so overlapping holes don't cancel). Menus, the command panel, hover cards, popovers,
    prompts, the downloads bubble and the peek are never clipped and draw above the player.
  - The holes follow the player's acknowledged viewport, not its mount: a layout effect applies them once the native
    layer has taken the player's rect (only the overlap of the old and new rects while a move is in flight), and a
    re-apply queued for the next animation frame is cancelled with them. A clip left behind also blocks hit testing,
    and `plainViewport` hit-tests the page's corners, so a leftover hole under a sampled point hides the page in every
    tab.
- **Pop-out.** The pop-out button, or dragging the player past the window's edge, turns it into Chromium's real PiP
  window on the same surface, so playback continues without a reload, a pause or leaving picture in picture. The
  in-window player stays until the real window has presented a frame. On X11 the window opens at the pointer (a
  drag) or where the player was (the button); on Wayland the compositor places it, and it takes focus as any new
  window does there, which the user asked for. A popped-out window is a deliberate PiP: it stays open when you go
  back to the tab.
- **Manual PiP.** It picks a candidate from the whole primary page, iframes included, ranked by unmuted, main frame,
  playing, then size. It never grants the page user activation.
- **Corner throws.** The gesture (`packages/ardiacore/ios/ArdiaPiPController+Swipe.mm`) is Mac-only. Wayland's
  `xdg_toplevel` doesn't let a client place itself, so a throw would need compositor integration.
- **Hyprland placement.** Hyprland 0.56.2's floating layout evaluates a `window_w` rule against the initial client
  width. Omarchy's PiP rule (600×338 at `monitor_w-window_w-40`) can therefore place a PiP window off the right edge.
  `ac_pip_linux.cc` and `ac_pip_hyprland.cc` work around it:
  - each PiP window gets an unguessable `ardia-pip-<token>` app id;
  - for the first second after it maps, the host waits for two matching compositor geometry samples and checks that
    the window's process is the browser;
  - one bounded Lua IPC request (`hl.dispatch(hl.dsp.window.move…)`) then moves an off-screen floating window into
    the monitor's work area with a 10-point inset. The correction allows for scale, rotation and reserved panels.
  - A visible window is left alone. Hiding, dragging, resizing or input cancels the attempt.
  - It writes no rules or config and changes no focus.
  - Without compatible IPC, the compositor keeps control. Other compositors, X11 and macOS are unchanged.

### Screen sharing

- **The shared-tab bar's Switch and Stop** (`media.changeCaptureSource`, `media.stopCapture`) are served by
  `ac_linux_capture.cc`. Switch presses Chromium's own "Share this tab instead" on the target tab's tab-sharing
  infobar for that capturer, so it answers false when Chromium offers no such button (a window or screen capture, a
  capture of a different kind). Stop ends the capturer's display capture through Chromium's capture indicator. Both
  reach only tabs of the caller's own kind of session, regular or private. With an older engine the shell refuses
  them as before (`hostCast.ts`). Neither has run against a real capture on Linux yet.
- **Casting.** Chromium's media router finds Cast devices over mDNS (DIAL discovery is off in Helium). Its device
  picker is Ardia's own, as on the Mac: `ac_linux_cast.cc` fills `chromium-cast-dialog-hook.patch`'s two hooks, so a
  cast request from a tab an Ardia window holds (Cast in the menu, a page's `PresentationRequest.start()`, a video's
  remote playback) keeps Chromium's `MediaRouterUI` and its fullscreen blocker and sends `media.castDialog` (id, open,
  header, sinks with their state, modes and route, `tabId`) to the window holding the tab. The host serves the six
  calls: `media.showCastDialog {tabId}`, `media.startCasting {id, sink, mode}`, `media.stopCasting {id, route}`,
  `media.closeCastDialog {id}`, `media.watchCastRoutes` (regular profiles only) and `media.terminateCastRoute
  {route}`, and sends `media.castRoutes {profile, routes}` to every window that isn't private. The shell hands the
  calls to the engine only when it advertises all six (`castsTabs` in `hostCast.ts`), so an older engine keeps the
  "Casting Isn't Available" toast.

### ardia browse off-screen tabs

- **The automation window.** `engine.cliMoveOffscreen` moves a tab the ardia command opened, and that was never shown,
  into a hidden Browser per regular profile (`ac_linux_automation_window.cc`). The host treats it as a companion:
  it is never shown or mapped, never restored by the session, and doesn't count as a window when closing. Chromium's
  `IsAutomationWindow` and `InAutomationWindow` answer true for it and its tabs, so `ardia browse set viewport` and
  emulation are allowed there. The tab's binding is dropped before it leaves its strip, and the shell's release of
  it then succeeds. Private tabs are refused.
- `engine.cliOwnsTab` answers from Chromium's own ownership record and shown-slot note, and
  `engine.cliCloseOffscreenTabs` closes every off-screen tab; they also close when the last browser window closes,
  so they never keep Ardia running.
- `engine.cliTabTargets` answers each regular tab's DevTools target id (`DevToolsAgentHost::GetOrCreateFor`) and a
  page generation that rises when the id changes, as the Mac does; a tab without a committed page answers null.
- **Unverified.** None of it has run in a built engine. Whether a page in a never-mapped window paints for
  screenshots is unknown.

### Page prompts

- **What reaches Ardia's UI.** Permission requests, password save and update offers, save-address,
  update-address and local save-card offers, and external-app ("open in app") requests from a tab the window
  shows. A WebContents no window shows keeps Chromium's own UI. `chromium-linux-page-prompts.patch` adds the
  hooks the Mac layer writes in with `engine/ardiacore/apply.sh` (the permission prompt factory, the File System
  Access restore dialog, the external-protocol dialog, PermissionRequestManager's tab activation), forwards each
  `AutofillBubbleHandlerImpl::Show*Bubble` for those tabs, and tells Ardia when Chromium hides its password
  bubble. The engine side is `ac_linux_page_prompts*.cc`, a port of the Mac's `ac_permissions.mm`,
  `ac_password_prompt.mm`, `ac_autofill_prompt.mm` and `ac_external_apps.mm`.
- **Delivery.** Permission requests go to the window that shows the tab as `permissions.requested` and
  `permissions.dismissed`, and an open one is delivered again when its tab is bound to a page (shell reload,
  move to another window). The other prompts are page events on the tab's leased document channel
  (`passwordPrompt`, `autofillPrompt`, `externalApp`). An open one is part of the page snapshot, a password
  offer only on the document it was made on.
- **Answers.** `permissions.resolve` and `permissions.resolveExternalApp` are accepted only from the window that
  shows the prompt's tab. `resolvePasswordPrompt` and `resolveAutofillPrompt` are claim-checked tab commands. A
  password offer is answered only while it is still the pending one; a password never travels on that route,
  and the prompt carries only its length. Allow and Don't Allow are remembered and Dismiss isn't, as on the
  Mac. A quiet request Chromium would drop (abusive notifications) is dropped.
- **External apps.** The app name is Chromium's (the scheme handler's desktop entry). When Chromium can only
  say `xdg-open`, the engine asks `xdg-mime` for the default handler; with none, the prompt says no app opens
  the link and launches nothing. A request needs an active initiating document when shown and when launched.
  "Always allow" follows Chromium's dialog (`ExternalProtocolDialogShowAlwaysOpenCheckbox`, trustworthy origin)
  and is never offered in private windows. Settings lists and removes the remembered choices through
  `permissions.externalAppAllowances` and `permissions.removeExternalAppAllowance`.
- **Autofill suggestions** are Chromium's own dropdown, as on the Mac. The Autofill menu command asks
  `autofill.showSuggestions` to open it on the field autofill last saw focused.

### Site controls and the content blocker

- **Routing.** Site permissions, per-site data and browsing-data clearing go through
  `ac_linux_site_controls_service.cc`. It validates arguments and resolves the profile in one function,
  `SiteControlsProfile`, before calling the shared `ac_site_settings_*`, `ac_site_data_clear` and
  `ac_browsing_data_clear`.
  - Origins must be `http(s)://host[:port]`, at most 2,048 bytes.
  - Private ids get `ERR_PROFILE_PRIVATE`, and isolated profiles get their own settings.
  - A clear that fails for one type answers `ERR_CLEAR_INCOMPLETE`.

  | Call | Arguments |
  | --- | --- |
  | `sites.settings` | `{origin, engine?}` |
  | `sites.setSetting` | `{origin, type, value, engine?}` |
  | `sites.origins` | `{}` |
  | `sites.reset`, `sites.clearData` | `{origin}` |
  | `profiles.clearBrowsingData` | `{types, since?}`; `types` is 1–4 of history, siteData, cache, downloads |
  | `contentBlocker.state` | `{}` |
  | `contentBlocker.setEnabled` | `{enabled}` |
  | `contentBlocker.setListEnabled` | `{id, enabled}` |
  | `contentBlocker.addList` | `{url}`; answers `{id, custom, existed, filters, failed}` |
  | `contentBlocker.removeList` | `{id}` of a list added by address |
  | `contentBlocker.isAllowed` | `{host}` |
  | `contentBlocker.setAllowed` | `{host, allowed}` |
  | `contentBlocker.hiddenElements` | `{}` on the named profile; answers its hiding rules |
  | `contentBlocker.hideElements`, `contentBlocker.restoreElements` | `{filters}` on the named profile; at most 10,000 filters of 3 KiB |

  The event is `contentBlocker.changed`.
- **Hidden elements.** Hide Element, Hidden Elements on This Site and Settings' Hidden elements read and write the named
  profile's own uBlock Origin "My filters", as on macOS, so each isolated profile keeps its own; nothing copies them
  between profiles. Only `host##selector` rules are hidden or listed: the C++ side checks the rule's shape and the bridge
  page checks it again, along with the selector, before appending the new ones and turning the My filters list on.
  Restoring drops the matching lines and reloads the lists. A private id reads and restores its original profile's rules,
  and hiding from a private window fails with `ERR_PROFILE_PRIVATE` (the shared UI keeps those rules in memory for the
  session). An empty `filters` answers `null` without reaching the blocker.
- **Your lists.** Lists added by address work as on macOS: the C++ side accepts an `http` or `https` address of at most
  2,048 printable ASCII bytes, and the bridge page checks it again and imports it through uBlock Origin, which keys the
  list by its address (so a list id is a plain id or such an address). Added lists show under `custom`, every list
  carries `failed`, and a private window can't add or remove one.
- **The blocker.** It is the same uBlock Origin component macOS loads, with the same id. Each regular profile loads
  it from `lib/ardia/extensions/ublock` (or `--ardia-content-blocker-dir`) through `ComponentLoader::AddOrReplace`
  once its extension system is ready.
- **The bridge page.** Calls run in a hidden `ardia-linux-bridge.html` page with a fixed set of operations; nothing is
  evaluated from a request.
  - Chromium refuses main-world script on extension pages, so the browser writes a DOM attribute from an isolated
    world and polls for the reply every 25 ms.
  - Each profile's queue gives a call a 20 s deadline, retries 40 times 250 ms apart and holds at most 64 calls.
  - The page holds a Web Lock so Helium's tab freezing never freezes it.
- **Restricted scripting.** `g_ardia_restricted_component_extension` is set in every process from
  `BasicStartupComplete`, so uBlock can't script `chrome://` pages, the shell, the Web Store or other extensions.
- **Isolated profiles.** These load their own copy. It follows the app profile's lists, exceptions and auto-update,
  copied on first load and after each change, along with the lists added by address (imported or removed to match).
  At most 512 lists and 10,000 directives of 2 KiB.
- **Navigation hold.** Until an isolated profile's blocker is ready on its first load in a run,
  `chromium-linux-navigation-hold-hook.patch` holds its page navigations for at most 2 s. Internal schemes aren't held.
  The app profile is never held, as on macOS. A new profile loads the packaged seed (see Seeded blocker), so its
  first pages wait only for the saved engine to load; without a seed uBlock Origin restarts itself once and compiles
  its lists, about 12 s on a loaded Xvfb box, and the first pages of a new install load unfiltered meanwhile.
- **Saved engine.** `ubo.sh` makes uBlock Origin save its compiled engine (its selfie) 3 s after its lists change
  instead of 53 s. Without it, a launch that ended within about a minute of the first one left no selfie, and the next
  launch rebuilt the engine from the compiled lists (about 3.2 s here) while its page requests waited on uBlock's
  blocking listener: first tab paint was about 3.8 s instead of 2.0 s on an existing profile. The smoke test's
  `content-blocker` check fails a package whose `js/background.js` lacks this delay or the 600 s update delay after
  launch, or whose blocker has no seed that `js/start.js` loads.

### Memory Saver

- **Routing.** Chrome's Memory Saver replaces Ardia's own tab sleeping, driven by the shared `ac_memory_saver` call.
  On Linux, `engine.memorySaver` and `engine.validateKeepActiveSite` go through `ac_linux_memory_saver.cc`. Both
  routes are in the bootstrap capabilities.
- **Validation.** It accepts:
  - `state` (`on`/`off`);
  - `aggressiveness` (`moderate`/`balanced`/`maximum`);
  - at most 1,000 `sites`. It drops empty sites, sites over 2,048 characters and sites with control characters.

  It never passes the engine's `validate` key through a settings write.
- **Scope.** State and mode are app-wide local state. The site list goes to every loaded regular profile, and private
  profiles are refused.
- **Startup.** Helium's `memory-saving-by-default.patch` applies on Linux, and the app pushes its setting at launch.
- **Tests.** `engine/ardiacore-linux/tests/test_memory_saver.py` and `apps/linux/src/hostCapabilities.test.mjs`.
- **Tab protection.** Unknown protection state counts as protected. `unsavedInput: null` protects a tab.
- **Loaded tab budget.** The shared budget (`state/tabs/loadedTabBudget.ts`) asks a hidden tab to sleep through its
  WebView handle's `sleepIfHidden(seconds)`, the `sleepIfHidden` tab command (`ac_linux_tab_sleep.cc`). As on the Mac,
  Chrome decides: `DiscardEligibilityPolicy` with the proactive reason and that hidden time, then
  `PageDiscardingHelper`'s own discard. The answer is `[]` when the tab slept, Chrome's `CannotDiscardReason` codes
  when something kept it, and `[-1]` when Chrome's performance manager has no page for it. The hidden time must be
  0 to 7 days. Test: `engine/ardiacore-linux/tests/test_tab_sleep.py`.
- **Memory pressure.** Read from PSI, falling back to `MemAvailable`. Power state comes from UPower and
  power-profiles-daemon signals.

### Calendar (Evolution Data Server)

Linux reads calendars from Evolution Data Server, which GNOME Online Accounts, GNOME Calendar and Evolution use.

- **Service.** One app-wide service (`ac_linux_calendar_service.cc`) runs every D-Bus call on its own GLib-pumped
  thread. Its EDS client (`ac_linux_calendar_eds.cc`) loads GIO at runtime and opens a private session-bus connection.
  GLib's shared connection would raise SIGTERM when the bus goes away.
- **Contract.** `ArdiaCalendar.status | requestAccess | sources | objects | timezones`. Status is one of
  `notDetermined`, `fullAccess`, `restricted` (no bus or no EDS) or `denied`.
  - `status` probes the bus without starting EDS.
  - Connect Calendar is the consent: `requestAccess` writes `linux-calendar.json`, and nothing is read before it.
  - Calls refuse with `ERR_CALENDAR_NOT_CONNECTED` until then.
- **Limits.**
  - 64 calendars, a 400-day range, 20,000 objects and 16 MiB per calendar, 32 MiB per reply.
  - One 90 s deadline per `objects` request.
  - A calendar that times out is skipped for two minutes.
  - Each calendar reports its own status, so one expired account doesn't hide the others.
- **Adapter.** `apps/linux/src/hostCalendar.ts` and `calendarIcs.ts` parse iCalendar and expand RRULE, RDATE, EXDATE
  and RECURRENCE-ID in the event's zone. They resolve TZIDs from IANA names, embedded VTIMEZONEs or EDS
  `GetTimezone`. A rule stops at 50,000 periods, and one refresh shares a 750 ms expansion budget. Truncated events are
  reported, not dropped.
- **Without EDS or a session bus.** The calendar is `restricted`, and Settings › Calendar says how to set it up. It
  recovers by itself when EDS appears.
- **Connect Calendar's answer.** `requestAccess` answers the shared `CalendarAccessRequest` with `responsible: "self"`.
  There is no system privacy pane to open: `calendarWording.ts` turns every "Open System Settings" into Try Again,
  makes `openCalendarPrivacy` do nothing and rewrites `calendarRequestFailure` in EDS terms.

### Extensions

- **Search providers.** Chromium allows `chrome_settings_overrides` only on Windows and macOS.
  `chromium-linux-settings-overrides.patch` adds Linux, so an extension's `search_provider` reaches `search.engines`
  and can become the default, as on macOS. The key's `homepage` and `startup_pages` stay off on Linux.
- **The page menu's search item.** Chrome's own page menu searches with Chrome's default engine, so
  `search.setEngineName` carries Ardia's default engine (`name`, `keyword`, `url`; macOS reads only `name`) and
  `ac_linux_search_engines.cc` makes it Chrome's default in every regular profile, including ones loaded later.
  "Search … for" then names and uses the same engine as the command bar, custom engines included.
  - A Chrome search engine (one with a search-terms placeholder) with the same name and host is selected as is.
    Otherwise one Ardia-owned engine is added or updated, with `%s` turned into `{searchTerms}`, and it's removed
    once another engine is the default. It has a fixed sync GUID and a fixed keyword,
    `ardia-default-search-engine`: Chrome resolves the default engine's searches by keyword, so Ardia's own shortcut
    could otherwise send them to another engine that shares it, an extension's say.
  - A default set by policy or by an extension is left alone. The request is checked first (name up to 256
    characters, keyword up to 256, an http or https URL up to 2048 with `%s`, no control characters).
- **Suggestions from extension engines.** A provider's `suggest_url` gets suggestions, as on macOS. Besides the
  built-in engines' endpoints, `CanFetchSuggestions` (`ac_linux_suggest.cc`) accepts the suggestions endpoint (https
  origin and path, then `?`) of an engine an extension controls in a loaded regular profile's TemplateURLService.
  Omnibox-API keywords don't count, and an unloaded service allows nothing. The shell's `suggestionRequestAllowed`
  mirrors this from `settings.extensionSearchEngines`, and sends each request with its origin and path canonical
  (lowercase host, no default port, dot segments resolved) and its query as built, so a template written
  differently from Chrome's canonical form still matches. The fetch is the same as for built-in engines: no cookies, no
  redirects, the same reply checks and per-window slots.
- **Keyboard shortcuts.**
  - Each browser window keeps a `LinuxExtensionKeybindings` registry (`ac_linux_extension_keybindings.cc`), and
    `chromium-linux-extension-keybindings.patch` stops Chromium's own registry from registering accelerators.
  - Ardia's shortcut table is checked first. A key Ardia binds never reaches an extension, even in text fields.
  - `_execute_action` (and the MV2 aliases) sends `extensions.actionShortcut`, and the shared toolbar opens the popup
    or side panel. Named commands fire `chrome.commands.onCommand`, and global commands keep Chromium's listener.
  - In private windows only incognito-allowed extensions are registered.
  - Chromium 156 has no `_execute_side_panel`; it is an ordinary named command.
- **Tabs and windows extensions open.** A tab Chrome inserts by itself (`chrome.tabs.create`, an action's
  `onClicked`, a URL handed to the running instance that the shell didn't take, see Links from other apps) has no
  opener page to report it, so the host does.
  - Each window notes tabs inserted outside Ardia's own operations (`unclaimed_` in `ac_linux_host.cc`). It also notes
    tabs already in the window when it attaches, unless they're blank or look restored by Chromium (more than one
    history entry, or an entry marked restored). In a window Chrome made, an `about:blank` tab counts too, so a
    later `chrome.tabs.update` lands in a tab the sidebar shows; Chrome's New Tab page is left to Ardia's own first
    tab, which adopts it.
  - A tab a page already reported, or one bound in any window, is left alone. A blank URL gets 20 tries, 25 ms apart,
    to resolve.
  - The shell asks for its window's waiting tabs once it listens (`ArdiaTabs.unclaimedTabs`) and gets later ones as
    `ArdiaTabs`/`unclaimed` events. A new renderer has to ask again, and gets again any tab an earlier renderer was
    told about but never bound. After a shell crash that can add a second sidebar entry for a background tab the
    crashed shell had saved, which is preferred over a tab nobody can see.
  - `apps/linux/src/unclaimedTabs.ts` opens each one in its own window, selected only if the extension asked for
    `active` and the tab is still Chrome's active tab.
  - A window Chrome makes (`chrome.windows.create`) is marked `chromeMade` in its bootstrap and lists its tabs in
    `adoptTabs`. `initialHostSession` seeds the window with them instead of a blank tab, and the window is saved like
    any other instead of waiting for an opener to save it.
- **Install prompts.** These are never auto-accepted. They show in the window of the tab that asked and end with that
  tab. Nothing installs without Add Extension. Popups size between 25×25 and 800×600, within the window.
- **Native messaging hosts.** Ardia looks for `<name>.json` in this order:
  1. `<Ardia data dir>/NativeMessagingHosts` (by default `~/.config/ardia/NativeMessagingHosts`);
  2. `~/.config/google-chrome/NativeMessagingHosts` (Helium's base patch; honours `CHROME_CONFIG_HOME`);
  3. `~/.config/chromium/NativeMessagingHosts` (`chromium-linux-native-messaging-hosts.patch`; honours
     `CHROME_CONFIG_HOME`, then `XDG_CONFIG_HOME`);
  4. `/etc/chromium/native-messaging-hosts`;
  5. `/etc/opt/chrome/native-messaging-hosts`.

  Hosts installed for Chrome or Chromium, such as Bitwarden and KeePassXC, are found without changes, because Web
  Store installs keep their Chrome ids for `allowed_origins`. Two exceptions:
  - 1Password talks only to browsers it knows, so add Ardia's binary to `/etc/1password/custom_allowed_browsers`;
  - Flatpak and Snap installs write manifests inside their sandbox, where Ardia doesn't look.

### Live folders

- **Native requests.** GitHub, Bitbucket, Notion, Confluence and Google Drive are reached from the browser process
  (`ac_linux_live.cc`, `ac_linux_live_service.cc`), never by renderer `fetch`. The shell keeps `connect-src 'none'`.
  - The Linux UI swaps the shared `state/live/sources.ts` and `net.ts` for `apps/linux/src/liveSources.ts` and
    `liveNet.ts`. These ask for fixed operations through `ArdiaLive.request`, `connect`, `cancel` and `disconnect`.
  - Native code builds every URL and adds the credential.
  - A GitHub GraphQL query must be read-only.
- **Transport limits.**
  - HTTPS only, no redirects, no cookies, no cache.
  - 20 s per request and 8 MB per reply.
  - 8 requests in flight and 256 queued.
  - Confluence sites must be `https://`.
- **Tokens.** Connect verifies a token with the provider before storing it. Tokens are kept in the Secret Service as
  "Ardia Live Folder Token" items (schema `dev.ardia.linux.LiveToken`, account = source).
  - Background test instances with an explicit `--user-data-dir` use a 0600 file instead.
  - Tokens are cached natively, wiped when freed and never returned to a renderer.
  - Google Drive tokens are renewed natively, and concurrent renewals share one request.
  - A locked keyring answers `ERR_LIVE_KEYRING_LOCKED` and never deletes a stored token.
- **Ordering.** A per-source generation counter keeps a late renewal from bringing back a disconnected token. A
  cancelled connect restores the previous token.
- **Private windows** get `ERR_PRIVATE_SERVICE`.
- **Rate limits.** GitHub's secondary rate limit and Drive's documented usage-limit 403s read as rate limited, not
  signed out. The shared macOS mapping still reads them as signed out.

### Passwords, cards and system authentication

- **Storage.** Ardia stores no secret of its own. Passwords live in Chromium's `Login Data` and card numbers in
  `Web Data`, both encrypted by OSCrypt.
  - The key comes from the Secret Service, KWallet or the secret portal (`--password-store`).
  - `ArdiaPasswords.status` and `ArdiaAutofill.status` report which key encrypts new data. They read the
    ciphertext's provider tag (`v10` built-in, `v11` keyring, `v12` portal) and flag Chromium's silent fallback to the
    obfuscating v10 key (`protectionFallback`).
  - An unreadable store answers `ERR_PASSWORDS_UNAVAILABLE` or `ERR_AUTOFILL_UNAVAILABLE`, never an empty list.
- **Reauthentication.** `ardia::Reauth` (`ac_reauth_linux.cc`) asks polkit for `dev.ardia.linux.reauthenticate`. The
  browser's own bus name is the subject, with interaction allowed and a 120 s timeout.
  - The policy is `auth_self` for active sessions and `no` for inactive and remote ones.
  - Only `is_authorized && !is_challenge` grants. Everything else is `denied`, `cancelled`, `expired` or
    `unavailable`.
  - Off-the-record profiles and background instances are `unavailable` without asking.
  - There is no test grant.
  - Unlock, reveal and edit share Chrome's five-minute grant. Export and card numbers prompt every time.
  - A newer request cancels the older one.
  - `ProbeReauth()` reports why authentication is unavailable without prompting: `notPermitted`, `policyMissing`,
    `noPolkit` or `background`.
- **Login password when polkit can't ask.** Where `dev.ardia.linux.reauthenticate` isn't installed (an AppImage, an
  extracted tarball) or polkit isn't running, reauth asks for the login password instead (from #1998): a native
  window-modal dialog over the profile's last active window (`ac_linux_password_prompt.cc`) whose password goes to
  the system's `unix_chkpwd` on stdin, never on a command line and never through a renderer
  (`ac_linux_password_check.cc`).
  - The helper must be a root-owned executable no one else can write, in root-owned folders no one else can write,
    at `/usr/sbin`, `/sbin`, `/usr/bin` or NixOS's `/run/wrappers/bin`; without one, reauth stays unavailable.
  - The helper runs with an empty environment and is killed after 15 s.
  - The password field isn't a Views `Textfield` (its model, edit history and `RenderText` keep copies that are freed
    without being overwritten). `PasswordField` (`ac_linux_password_field.cc`) keeps the typed text and any IME
    composition in `SecretText` (`ac_linux_secret_text.cc`): a fixed-size buffer in its own mapped page, left out of
    core dumps and forks, locked against swap where allowed, edited in place and zeroed before it's unmapped. It draws
    bullets from a character count, has no undo, refuses paste and copy, gives the IME no surrounding text and
    exposes no value to accessibility. On Confirm the text is encoded straight into another such page, which the
    helper's stdin write reads from; submit, cancel, closing the window, a superseding request and teardown all zero
    it. What it can't cover: each keystroke's own event, the IME's commit buffer for that keystroke, and the kernel's
    socket buffer.
  - `scripts/linux/password-heap-check.mjs` types random passwords into the real dialog of a package under Xvfb and
    scans the browser process's memory, as UTF-8 and UTF-16: while typed the password must exist exactly once, text
    typed over or erased must be gone while the dialog is still open, and nothing may be left once it closes.
  - Wrong passwords back off 2 s, 5 s, 30 s, then 60 s. The grant window and supersession are polkit's.
  - `ProbeReauth` reports such a system as available (`loginPassword`), and `reauth.requested` says which method ran.
- **Secret routes.**
  - Secrets travel only on typed calls (`ArdiaPasswords.reveal|save|update|export|unlock`,
    `ArdiaAutofill.cardNumber|saveCard`), as hex buffers sized exactly and wiped after use.
  - Generic `engine.call` refuses those names with `ERR_SECRET_ROUTE`. Generic payloads are rebuilt from allowlisted
    fields.
  - The engine's reveal and card-number replies are serialized into a pre-reserved buffer and cleansed (Linux only).
  - Export writes Chromium's CSV and sets mode 0600. A file the export created is deleted if the export fails.
  - The credential sources contain no logging, and a test enforces that.
- **What can't be wiped.** V8 strings in the UI renderer, and Chromium's own IPC and `base::Value` copies.
- **Private windows.** Credentials resolve their profile in one function, `ResolveCredentialProfile()`. A private
  window's renderer, or any off-the-record profile, gets `ERR_PROFILE_PRIVATE` for every credential call.

### Sync

- **Format.** Folder sync uses the macOS format byte for byte (`ac_linux_sync_crypto`, `ac_linux_sync_vault`), so a
  Linux and a Mac install can share a Syncthing, Dropbox or NAS folder.
  - HKDF-SHA256 key derivation.
  - `NNS1` files with AES-256-GCM and 1 KiB padding.
  - A 24-word BIP-39 phrase.
- **Writes.** Files are staged `O_EXCL|O_NOFOLLOW` at 0600, fsynced, then published with
  `renameat2(RENAME_NOREPLACE)`. Everything below the chosen folder is opened with `openat`.
- **Folder.** The default is `$HOME/Ardia Sync`, or `--ardia-sync-folder`.
- **Key.** The sync key is a Secret Service item, "Ardia Sync Key" (schema `dev.ardia.linux.SyncKey`). Showing,
  copying or saving the recovery words asks polkit, then allows 60 s.
- **One authority.** Only one browser renderer syncs: it holds a Web Lock plus a native lease that expires 30 s after
  its last renewal. The other windows mirror its state. Utility and private windows are never the authority.
- **Passwords** sync sealed through a native path. Logins Linux can't hold are kept in `sync-held-logins.nns`.

### Import

- **Sources.** Chromium-family profiles under `$XDG_CONFIG_HOME`: Chrome, Chromium, Brave, Edge, Vivaldi, Opera and
  Helium, plus Flatpak and Snap variants. Also Firefox (native, Flatpak, Snap), LibreWolf and Zen (native and
  Flatpak). Firefox 147 and Zen follow the XDG layout: a new install lives in `$XDG_CONFIG_HOME/mozilla/firefox` or
  `$XDG_CONFIG_HOME/zen`, and an older one stays in `~/.mozilla/firefox` or `~/.zen`. Import reads the older folder
  when it holds a `profiles.ini`, which an install from before the change keeps using, and otherwise the XDG one; the Flatpaks have the
  same pair under `~/.var/app/<app id>/` (`.mozilla/firefox` or `.zen`, then `config/…`).
- **Kinds.** Bookmarks, history, passwords, cookies, addresses, cards, open tabs and favicons. Zen also brings its
  sidebar, as on the Mac and Windows (`ac_linux_import_zen.cc`): its spaces, Essentials, pinned tabs and folders, and
  each space's open tabs. It reads `zen-sessions.jsonlz4`, then `zen-sessions-backup/clean.jsonlz4`, then the dated
  backups newest first, then the Firefox session store, with `places.sqlite`'s `zen_workspaces` as the fallback for an
  older Zen. `importData` passes the chosen spaces as `spaceIds` (at most 256 ids of up to 256 bytes each). Tab icons
  come from the session's PNGs first, then from `favicons.sqlite`.
- **Copies.** Databases are copied `O_NOFOLLOW` into a private temporary folder. Copies older than an hour are swept.
  Source files are never written.
- **Passwords never reach the renderer.**
  - It sees only a token and a count. The token is 128 bits, bound to its window and single-use within 10 minutes.
  - Any reply that carries a password is refused.
  - Writes go through Chromium's `PasswordImporter`, and a conflict keeps the stored password.
- **Chromium keys.**
  - `v10` uses Chromium's built-in key.
  - `v11` is read from the Secret Service or KWallet. The keyring probe never unlocks it, and the consented read may
    raise the keyring's own unlock prompt.
  - `v12` (secret portal) data can't be read.
- **Firefox.** `key4.db` with or without a primary password, and `logins.json`/`logins.db`.
- **Files.** A file import uses only a path the native chooser returned to the same window, once.
- **Refreshing open windows.** Imported bookmarks and history reach open windows without a relaunch.

### The `ardia` command

It works as on the Mac ([cli.md](cli.md), [automation.md](automation.md)); what differs:

- **Version.** `systemInfo.appVersion` is the content of `lib/ardia/VERSION` when it is one well-formed line (a digit
  first, then digits, letters, `.`, `-` or `+`, at most 64 characters), else Chromium's version as before. `hello`, the
  release-notes bookkeeping and the CLI upgrade check all read it. The first launch with a `VERSION` file counts as an
  update, but Linux sets no release-notes page or `isolatedInstance: false`, so no tab opens; only a postcard shows,
  and only when the shared notes have that exact version. A dev build without the file keeps reporting Chromium's
  version.
- **Token server.** `ac_cli_control.cc` and the token policy are shared code now, unchanged. `ArdiaControl.json` is
  `<user data dir>/ArdiaControl.json` (0600). `engine.cliControlStatus`, `engine.setCliControl` and
  `engine.setCliActiveTab` are typed host calls (`CliControlCall` in `ac_linux_host.cc`), and the `cliControl` topic is
  sent to every window as `engine.cliControl`. Each window's renderer reports its own shown page. The tab
  `/ardia/active` names is kept by the last window that resolved a tab of its own (never an incognito one), and a null
  from another window doesn't clear it. `--remote-debugging-port` makes the status `external` and the server never
  starts. Tests reach the token path with `--remote-debugging-pipe`, which leaves it alone.
- **Control socket** (`ac_linux_automation.cc`, `ac_linux_control_core.cc`). It is a port of `ControlSocket.swift`,
  `ControlConnection.swift` and `ControlOutput.swift` with the same limits, framing, dropped-event marking, generation
  and ticket semantics. It listens on `<user data dir>/ArdiaControl.sock`, beside `ArdiaControl.json`, with
  `ArdiaControl.sock.lock` next to it; the CLI's data root on Linux is that folder (`--data-dir`, `$ARDIA_DATA_DIR`,
  else `${XDG_CONFIG_HOME:-~/.config}/ardia`). The peer is checked with `SO_PEERCRED`, and a path over 107 bytes is
  refused with a logged line and an error status. The umask is never touched: the socket is bound in a fresh 0700
  staging folder in the data folder, made 0600 and checked there, then renamed into place while the lock is held.
  I/O runs on a thread-pool sequence; routing and events run on the UI thread.
  Every regular browser window starts automation (not Settings or private windows); the socket is one per process and
  the windows that started it are its participants:
  - a connection's requests go to the window that was focused most recently when its first line arrived;
  - `run` goes to the window it names, or else to the most recently focused one, so the command runs in that window's
    renderer as a shortcut would;
  - replies are taken only from a window that was given that request, and written tickets go back to the window that
    issued them;
  - a window whose renderer goes away (closing or reloading) closes the connections it was serving, and lines already
    queued from them are dropped rather than handed to another window; the last one leaving stops the socket, and
    turning `cliControl` off stops it at once;
  - a start that a stop overtook joins the socket if another window has started it again since, and otherwise
    settles `off` ("The control socket was stopped while it started."), never with a stale generation.
- **Installer** (`ac_linux_cli.cc`, a port of `CliInstaller.swift`). `ArdiaCli.installedVersion` is the basename of the
  `current` link in `${ARDIA_CLI_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/ardia/cli}`. The bootstrap carries it
  (`nativeModules.ArdiaCli`) so the shared code can read it synchronously, and `apps/linux/src/hostCli.ts` keeps it
  current from installs and the `onInstalledVersion` event.
  - `ArdiaCli.install` runs `/bin/sh lib/ardia/cli/ardia-cli-install.sh --version <VERSION> [--sha256 <digest>]` from
    the temp folder with stdin on `/dev/null`. It gets the browser's environment minus every `ARDIA_*` variable, plus
    `ARDIA_CLI_HOME` and `ARDIA_CLI_BIN_DIR` when set and `ARDIA_CLI_URL`: the browser's own value if it has one,
    else `file://` of the bundled tarball when it exists.
  - stdout lines stream as `onInstallLine` to every window waiting on the run. Calls made while a run is going join it.
    The installer runs in its own process group. After 300 s the group gets SIGTERM, then SIGKILL 5 s later, and the
    result is the failure "The installer didn't finish in 300 s, so it was stopped." Output is drained for at most
    10 s after the shell exits (or after the kill), so a leftover child holding the pipes can't stall it. The bridge
    gives `ArdiaCli.install` 330 s (`bootstrap.js`). The result is parsed as on the Mac (`ok`,
    `appVersion`, `binPath`, `version`, `rcFile`, `error`, `lines`, `status`, `installedVersion`), and a version that
    doesn't match `^[0-9]+\.[0-9]+\.[0-9]+(-[a-z]+\.[0-9]+)?$` is refused.
  - The launcher is `bin/ardia` and the CLI links `~/.local/bin/ardia`; they don't collide.
  - An instance started with its own `--user-data-dir` is a test instance: it installs only with both
    `ARDIA_CLI_HOME` and `ARDIA_CLI_BIN_DIR` set, and reports no installed version without `ARDIA_CLI_HOME`.
- **Config files** ([config.md](config.md)). `config.json` and `themes/` live in `<user data dir>/config`
  (`~/.config/ardia/config` by default), not beside Chromium's files; the CLI resolves the same folder, so
  `ardia config set|unset|edit` and `ardia theme new|use` reach a running Ardia. `ArdiaConfig.readFile`, `watch` and
  `writeSchemas` are native (`ac_linux_config_core.cc` for the files and the inotify watcher, `ac_linux_config.cc`
  for the threads and the windows), with the Mac's limits; the schemas go to `<user data dir>/config-schema/` and into
  the config folder when it exists. `apps/linux/src/hostConfig.ts` keeps each window's reads so the shared code can
  read synchronously, and refreshes them on the host's `onFilesChanged` before it raises `onChange`. An engine that
  doesn't advertise the three methods keeps the old answers (no folder, nothing watched).
- **UI.** `apps/linux` turns the Settings rows on from the host's capabilities (`cliControl` needs the three engine
  calls and the four `ArdiaAutomation` methods; `cliInstall` needs both `ArdiaCli` methods), so an older engine still
  hides them. `startCliControl` runs in every window, Settings included, so the pill and the Settings note follow the
  server. The shared UI has no onboarding step for the command; it is offered in Settings › Advanced.
- **Userscripts** (`ac_linux_user_scripts.cc`, with the Chromium-free store in `ac_linux_user_scripts_store.cc`, a
  port of `UserScripts.swift`). `ArdiaUserScripts.watch`, `read`, `readStatus` and `writeStatus` are host methods on
  `<user data dir>/Scripts`, where the CLI writes and the engine's scripts policy (`ac_scripts_policy.cc`) looks.
  - `read` takes a shared `flock` on `Scripts/.lock` (200 tries 50 ms apart, else `busy`) and answers the Mac's
    states with the same generations and error strings: `empty`, `absent`, `pending`, `invalid` or `ready`, the path
    as `realpath(<user data dir>)/Scripts/extension`, and the change token. The manifest is checked as on the Mac
    (only content scripts, at most 1 MiB, every `js`/`css` file a plain relative file with no link on the way).
  - Symlinks are refused rather than followed: `Scripts`, `extension`, `generation`, `manifest.json` and
    `status.json` are opened with `O_NOFOLLOW` and everything below works from folder descriptors. A linked
    `Scripts` or `extension` reads `invalid`; `writeStatus` refuses a linked `Scripts`.
  - `writeStatus` writes `status.json` through a temp file and `renameat` (at most 1 MiB); `readStatus` answers null
    for a missing, linked, oversized or non-UTF-8 file.
  - `watch` uses a non-recursive `FilePathWatcher` on `Scripts` (direct children, as the Mac's folder source), lets
    changes settle for 100 ms and sends `ArdiaUserScripts`/`onChange` only when `generation` or the `extension`
    folder's inode and mode changed. A failed watch is re-armed after 1 s. Only the windows that asked to watch get
    the event, and a window whose renderer goes away stops watching; the last one stops the watcher.
  - All file work runs on one thread-pool sequence. Only regular browser windows may call these methods (not
    Settings or private windows).
  - The UI turns userscripts on when the host advertises all four methods (`userScripts` in `hostCapabilities.ts`).
    One regular window at a time runs the shared `startUserScripts`, chosen by the `ardia-user-scripts` web lock
    (`hostUserScripts.ts`); when it closes, the next window takes the lock and applies the folder again.

### Telemetry

- **Opt-in, as on the Mac.** Sharing is off until the person turns it on: onboarding's last step asks, the new tab
  page asks once if onboarding didn't, and Settings › Privacy & Security has the toggle. With sharing off nothing is
  posted except the daily anonymous "opened today" count, which the Mac sends too (and a test instance skips).
  Native crash reports come from Chromium's own crash handler (Crash reports, below); with an engine that doesn't
  list its dumps `ArdiaApp.crashReports` answers an empty list, and "crash reports" there means page-process exits
  and JavaScript errors. The group has no crash-report control of its own to hide.
- **Crash reports.** `chrome_crashpad_handler` runs beside every Ardia process and writes a minidump for each crash of
  the browser, page, GPU and helper processes into `~/.config/ardia/Crash Reports` (`pending/<uuid>.dmp`), or `<user
  data dir>/Crash Reports` for an instance started with `--user-data-dir` (`ardia-launch` sets
  `BREAKPAD_DUMP_LOCATION`, which Chromium reads before it starts the handler, so a test instance never leaves its
  dumps for the everyday profile to report). An unbranded build never has consent to upload, so the dumps stay on the
  computer. At launch the telemetry owner asks for the dumps written since its cursor (`ArdiaApp.crashReports`,
  `hostCrashReports.ts`). The engine advertises `crash.dumps` to regular browser windows and serves two calls from
  Chromium's crashpad database (`chrome::DIR_CRASH_DUMPS`, `ac_linux_crash_dumps.cc`) on the thread pool:
  `ArdiaCrash.list(since)` answers the pending and completed reports written after `since` as `{id, time}` (the dump's
  modification time in milliseconds), the newest 32; `ArdiaCrash.read(id)` answers one dump as base64, or null when
  it's gone or over 8 MiB. Settings and private windows are refused. The shell reads up to the newest 16, parses each
  one (`minidump.ts`) and keeps the newest five of the browser and five of the other processes, as the Mac does. A
  report carries the process kind (from Chromium's `ptype` annotation), the signal and its code (`SIGSEGV`,
  `SEGV_MAPERR`), the engine version (Ardia's own version for a browser crash, from the `ardia-ver` annotation the
  engine sets at startup from `VERSION`), the process's uptime, the build IDs of the files beside `chrome`, and the
  crashing thread's frames as file plus offset: a frame-pointer walk from the signal's registers (Linux builds keep
  frame pointers), and when libc reused the frame pointer, from the first frame record on the stack. A dump written
  without a crash (`DumpWithoutCrashing`) is skipped. Nothing else from the dump leaves the shell: it holds stack
  memory, which can hold page content. The shared client sends it under the same consent as the Mac (sharing on only);
  `chrome` is stripped, so its frames are offsets, named later against the engine's symbols by build ID.
- **One owner for the choice.** A window that isn't the telemetry owner (Settings, a second browser window) doesn't
  write `telemetry.json`. Turning sharing on or off, dismissing the new-tab question, starting or stopping a report's
  14-day watch and making the first anonymous ID are `choice` requests the owner runs (`telemetryChoice.ts`,
  `handleTelemetryOp`); the owner saves, announces, and every window re-reads the document. The asking window shows a
  sharing answer at once and falls back to the saved state if no owner answers within 10 s.
- **Sending.** The shell can't fetch, so the shared client posts through `ArdiaTelemetry.post` (`ac_linux_telemetry.cc`):
  native sends the OTLP body to the fixed `https://ardia.dev/otel/v1/logs` with the app's ingest key, over the system
  network context with no cookies, and answers the HTTP status (0 for a network error). JS keeps its queue, batching and
  backoff. Events carry `$os: Linux` and `os.type: linux`; the `ardia` command reports the same on Linux.
- **One owner.** Every window runs its own copy of the UI, so one browser window holds the `ardia.linux.telemetry` lock
  and runs the client (queue, flush, hourly usage, the daily ping) (`telemetryLeader.ts`). The others, utility windows
  included, forward `capture` and log calls to it over a `BroadcastChannel`. The owner acknowledges each one, and a
  window keeps what nobody acknowledged and sends it again when a new owner announces itself, so nothing is lost while
  ownership moves. Anything that changes the telemetry state (resetting the anonymous ID, ending or reopening the
  session) is a request the owner runs, answered once per request id. When the owner closes, the next window in line
  takes the lock, re-reads the telemetry documents and resumes the same session; the `telemetry` launch step tells it
  this is a takeover, not a new launch, and a session that was already ended stays ended.
- **The 7-day local copy.** `ArdiaTelemetryLocal` is TypeScript on Linux (`hostTelemetryLocal.ts`). The lines live in
  the shell's IndexedDB (`ardia.telemetry-local`, one store of `{day, text}` chunks), which every window of the instance
  shares because every shell runs in the app profile. Only the telemetry owner records, each write, prune and clear is
  one transaction, and a private window never writes. A prune applies the Mac's rules (7 days, 8 MB, oldest first,
  down to nine tenths) and folds each day into one record. View My Data saves `Ardia data <day>.jsonl` as an ordinary
  download of a blob from the shell, so it lands in the Downloads folder (or wherever downloads are set to go, with
  Chromium's ` (1)` suffix for a second file), shows in the downloads list and can be shown in the file manager.
  Before it reads, the exporting window asks the owner to flush its buffer (`ardia.linux.telemetry-local` channel).
  The `ardia` command's own lines aren't in the export. Watch `telemetry_local_store` (`write_failures`, `bytes`,
  `lines_dropped`) and `local_copy_exported` (`ok`) from Linux.
- **Session end.** When a close ends the session (quitting or the last browser window), the closing window asks the
  owner to record `app_session_ended` and save its queue before the close is acknowledged (2 s at most); an owner
  closing alone just saves its queue. If that close is then cancelled, the session reopens, but only if no later close
  ended it again. A session killed without a close (logout, SIGKILL) shows up as unclean on the next launch.
- **Test instances.** The bootstrap's `isolatedInstance` is true under `--user-data-dir` or `ARDIA_DATA_DIR`; such
  instances send with `$environment: test` and skip the daily ping, as on macOS.

### Default browser, launch at login and links to other apps

`ac_linux_desktop_core.cc` holds the logic, with no Chromium in it, and `ac_linux_system.cc` the threads, the
`xdg-settings` process and the replies. The file and process work runs on one thread-pool sequence, never on the UI
thread. The reply shapes are the Mac's (`packages/shell/ios/SystemModule.swift`, `AppModule.swift`).

- **This copy of Ardia.** The launcher is `<prefix>/bin/ardia`, found from the running `chrome`
  (`<prefix>/lib/ardia/chrome`). A desktop entry counts only when its `Exec` program resolves to that launcher or to
  `chrome` itself (symlinks followed; a bare name is looked up in `PATH`).
- **The installed entry.** The first `ardia.desktop` in the `applications` folders, in XDG order, the one
  `scripts/linux/package.py` writes and `install.sh` installs with an absolute `Exec`. It must be `Type=Application`,
  not `Hidden`, start this copy and list `x-scheme-handler/http` and `x-scheme-handler/https` in `MimeType`. At most
  64 KiB is read.
- **`ArdiaSystem.isDefaultBrowser`** answers a boolean: what `xdg-settings check default-web-browser ardia.desktop`
  says (5 s at most). It answers false, without running anything, when there is no usable installed entry (an
  extracted folder, an install under a prefix outside `XDG_DATA_DIRS`, an entry that starts another copy) or no
  `xdg-settings` in `PATH`, and false when the tool fails, times out or says anything but `yes`.
- **`ArdiaSystem.setAsDefaultBrowser`** runs `xdg-settings set default-web-browser ardia.desktop` (15 s at most), then
  the check again, and answers the check, as the Mac answers its probe. The same refusals answer false, and the reason
  is logged.
- **`ArdiaSystem.launchAtLoginStatus`** answers `enabled`, `notRegistered` or `notFound` (never the Mac's
  `requiresApproval`). `notFound` means this copy has no launcher to start (a raw build tree) or there is no home
  folder. `enabled` means `<autostart>/ardia.desktop` is an application entry that starts this copy and is neither
  `Hidden=true` nor `X-GNOME-Autostart-enabled=false`.
- **`ArdiaSystem.setLaunchAtLogin(enabled)`** writes that entry (`Exec` is the launcher, quoted by the Desktop Entry
  rules) to a temporary file in the autostart folder, syncs it and renames it into place, so a link at that name is
  replaced, never written through. Missing folders are created with mode 0700. Turning it off removes the entry. A
  failure rejects with `ERR_LOGIN_ITEM`. It works from an extracted folder too, which needs no installed entry.
- **`ArdiaApp.openExternalURL(url)`** answers a boolean. A valid URL of at most 32 KiB goes to
  `platform_util::OpenExternal` (the portal, else `xdg-email` for `mailto:` and `xdg-open`), and the answer is true
  once it is handed over; Linux can't tell whether an app opened. The Mac takes any scheme; Linux also refuses the
  schemes that run or read local content (`file`, `javascript`, `data`, `blob`, `about`, `view-source`, `chrome` and
  its relatives, `devtools`, `filesystem`, and Chromium's own external-protocol blocklist).
- **Background instances** run no tool, write no entry and open no app: the default browser calls answer false,
  `setLaunchAtLogin` resolves without changing anything and `openExternalURL` answers false. The login status is still
  read.

### Links from other apps

A link another app opens (`xdg-open`, a mail client, `ardia <url>` in a terminal) reaches the shell as the Mac's
`ArdiaShell`/`onOpenURLs` event, `{urls}`, so Open links from other apps in Little Ardia, link rules and Put links from
other apps first apply. The Mac's `source` and `pointer` are left out: Linux can't tell which app sent a link, and the
Mac leaves `source` out too when it doesn't know.

- **The hook.** `chromium-linux-open-urls.patch` asks `ardia::TakeLinuxLaunchUrls` (`ac_linux_launch_urls.cc`) in the
  two places Chromium turns command-line arguments into tabs: `StartupBrowserCreator::Start` (the launch that starts
  Ardia) and `ProcessCommandLineWithProfile` (a second launch, handed to the running process through the process
  singleton). The URLs are the ones Chromium itself would open (`StartupTabProviderImpl::GetCommandLineTabs`).
- **What the shell takes** (`ShellTakesLaunch` in `ac_linux_open_urls.cc`, no Chromium in it): 1 to 64 valid `http`,
  `https` or `file` URLs of at most 32 KiB each. Anything else stays with Chromium, which opens it as before and the
  window adopts the tab (`unclaimedTabs.ts`): another scheme, a launch with `--incognito`, `--new-window`, `--app`,
  `--app-id`, `--kiosk`, `--guest`, `--headless`, `--no-startup-window`, `--silent-launch`, `--profile-directory` or
  `--profile-email`, a background instance (`ARDIA_BACKGROUND`), and a running Ardia with no regular browser window
  (only private or utility windows).
- **At launch.** The URLs are taken off the command line Chromium starts from (`LinuxLaunchWithoutUrls` keeps the
  program and every switch), so Ardia starts as it does without a link and restores its windows, then gets the links,
  as on the Mac.
- **Delivery.** Links wait natively (at most 256) until a regular browser window says it listens
  (`ArdiaShell.listenForOpenURLs`, which `openUrls.ts` sends once the shared listener is registered). They go as one
  event to the listening window that was active most recently; private and utility windows are never chosen and
  don't get the capability. A renderer that reloads has to say it listens again.
- **Capability.** `ArdiaShell.onOpenURLs` and `ArdiaShell.listenForOpenURLs`, in regular browser windows only.
- **Unchanged.** The `ardia` command opens pages over its control connection, never by launching the browser, and a
  second launch without a URL still opens a window.

### Full screen and page editing commands

- **`ArdiaShell.toggleFullScreen(windowId)`** enters or leaves full screen for a browser window the caller reaches
  (`FullscreenController::ToggleBrowserFullscreenMode`, the path the fullscreen restore uses) and answers the state it
  is going to: `true` entering, `false` leaving. A page's own full screen ends the same way. Utility windows are
  refused. The shell already hears the result as the `fullScreen` window event.
- **`tab.command` `edit`** with one argument, `undo`, `redo`, `cut`, `copy`, `paste`, `pasteAndMatchStyle` or
  `selectAll` (the Mac's `std:` selector names), runs that command in the claimed tab's focused frame
  (`content::WebContents::Undo` and the rest) and answers null. An unknown action is refused. The host advertises it
  as `tab.edit`.
- The app menu offers both when the host advertises them (see Windows, focus and input › Menu button).

### Links in pinned tabs and Little Ardia windows

Both are ports of the Mac's native code (`ArdiaWebView+Peek.mm`, `ArdiaWebView+Tab.mm`), with the rules in
`ac_linux_link_tabs.cc` and `ac_linux_link_gesture.cc` (no Chromium in either) and the same page script.

- **`webView.setPeekOtherSiteTabs {tabIds}`** (Settings › Tabs › Open a Peek window when clicking on links to other
  sites). Each window's shell sends the tabs that peek, and the host keeps that window's list (at most 4,096 ids of
  256 bytes) until its renderer goes away. A tab on the list hears `otherSites: true` in its main frame's `peekConfig`
  and `config`, when the list changes and whenever a document greets; subframes and every other tab hear `false`.
  - The page script then holds back a plain left click on a link to another site and asks with a `peek` message whose
    key is `site`. The host peeks only when the tab is still on the list, the message came from the main frame, the
    page is shown, and the last left mouse-up was over this page, at most 10 s ago, with no modifier and not used or
    pressed again since. The shell gets `openWindow` with `disposition: "peek"`, `site: true` and the click point.
  - In every other case the host answers `peekRefused` with `follow: true` and the link's own text, and the page
    follows the link as the click would have. That includes a tab that left the list, a hidden page, a shell that
    isn't attached and an `openWindow` the shell's lease refused. A tab whose page loses its shell is told
    `otherSites: false` at once, so it stops holding clicks back.
  - With the setting off, or in a tab that isn't on the list, the page script never holds a click back and nothing
    here runs. Link clicks have their own message allowance per document (64, refilled at 32 a second), so a page
    that floods the channel can't make a held click vanish.
- **`webView.setLittleArdiaOpensNewTabLinks {enabled}`** (Settings › Tabs › Links › Keep new-tab links inside a Little
  Ardia window). The setting is one for the whole app, as on the Mac. A window is a Little Ardia window when its
  shell opened it with `kind: "small"`.
  - The page script notes each link it expects to open a tab (`newTabLink`: a `target` click or a `window.open` with
    user activation). A tab keeps its last four notes for two seconds.
  - When a page in such a window opens a foreground tab, the host waits for the tab's address if it starts blank (20
    tries, 25 ms apart), then looks for the note: the tab's first or current address, or, for a tab that started
    blank, the newest note of the last second. Without a note it tries again 8 times, 25 ms apart, if the tab had a
    mouse or key press in the last 5 s. These are the Mac's numbers.
  - On a match the opened tab is closed, unless a window has taken it, as soon as Chromium has put it in a tab
    strip (Chromium reports a new tab before it adds it), and the shell gets `openWindow` with the
    noted address, `disposition: "current"`, `userGesture: true` and `linkWait: "matched"`, so the page opens in
    the Little Ardia window's own tab. Without one the tab is reported as before, with `linkWait` `skipped` or
    `timedOut`.
  - With the setting off, or in any other window, a new tab is reported at once, exactly as before.

### Link status, scroll bars, hardware details and page commits

- **Link status.** The `status` page event carries `fromBottom` beside `text`, as on the Mac: the pointer's distance
  from the page's bottom edge, in the shell's points, when the pointer is over the page
  (`ShellHostView::PointerFromPageBottom`, `ac_linux_status_geometry.h`). The shared UI moves the bubble to the top
  when the pointer is near the bottom.
- **`ArdiaSystem.setThinScrollBars(thin)`** (Settings › Appearance › Scroll bars). Helium turns on Chromium's
  overlay scroll bars in the mode that follows the OS, which on Linux is GTK's `gtk-overlay-scrolling`.
  `chromium-linux-thin-scroll-bars.patch` adds `ui::NativeTheme::SetArdiaLinuxThinScrollBars`: Thin makes
  `NativeTheme::CalculateUseOverlayScrollbar` prefer overlay scroll bars whatever GTK says, and the change runs the
  path an OS setting change takes, so open pages switch without a reload and new ones start that way. The shell
  sends the setting at every launch.
- **`ArdiaShell.setAppearance(mode)`** (Settings › Appearance, View › Appearance). The Linux counterpart of the
  Mac's `NSApp.appearance`: Dark and Light set Chromium's app-wide
  `ui::NativeTheme::SetPreferredColorSchemeOverride`, Auto clears it so the GTK or portal color scheme applies
  (`ac_linux_appearance.h`, `ac_linux_system.cc`). Both native themes recompute and notify, so browser windows,
  their pages, the shell and Incognito pages all get `prefers-color-scheme` from it without a reload. The shell's
  `isDarkAppearance` asks the engine (`ArdiaShell.isDarkAppearance`), and while the engine applies the mode the
  shell's own `prefers-color-scheme` query is the effective appearance (`apps/linux/src/hostAppearance.ts`).
  A profile whose Chrome `browser.theme.color_scheme2` pref is not System still wins over it for its regular pages.
- **`ArdiaApp.hardwareInfo`** answers the Mac's `{chip, gpu?, memoryGB, displays, maxScale, hardwareDecode}`
  (`ac_linux_hardware.h`): the chip from `base::SysInfo::CPUModelName`, read off the UI thread; memory from
  `AmountOfTotalPhysicalMemory`, rounded to gigabytes; the GPU's device name, else its GL renderer, from Chromium's
  GPU info, left out when unknown; the display count and the largest scale factor from `display::Screen`; and
  `av1`, `vp9`, `hevc` and `h264` from the hardware decoder profiles the GPU process reports. Names are trimmed to
  256 bytes. Telemetry's hardware fields and Copy Diagnostics get real values.
- **`tabs.reportCommits {on}`** turns on the Mac's commit stamps for one window's tabs, until its renderer goes
  away: each `navigation` event then carries `committedAt` (the time, in milliseconds, of the tab's last
  cross-document commit in the main frame, 0 before the first) and `httpStatus` when that document had a response
  status. The `ardia` command's page events (`page.error`, the held navigations) use them.

### Pointer hand-off, Escape, app activation and small windows

- **The pointer over a page.** Aura sends the shell's page a mouse-leave whenever a real pointer move lands on a
  page view (`WindowEventDispatcher` moves its mouse-moved handler and exits the old one), so hover cards, tooltips
  and CSS `:hover` in the shell end as they do when the pointer leaves a window, and `motion/pointer.ts` sees the
  `mouseout`. Two things hid that. Input sent through DevTools (`Input.dispatchMouseEvent`, which the headless
  suites use) goes straight to one renderer and never produces the leave. And new input regions arriving under a
  pointer that doesn't move left the shell hovered until the next move, for example when an overlay under the
  pointer closed. After every `shell.inputRegions` the host now checks that case (`ShellHoverIsStale`,
  `ac_linux_pointer_regions.h`: the shell's view is Aura's hovered window, no button is down and the last pointer
  position is in a pass-through rectangle) and sends Aura one synthesized move at that position, the event Aura
  itself sends after a window changes, so the shell gets its leave and the page its enter. There is no new event
  and nothing for the shell to wire.
- **Escape a page leaves unhandled.** `chromium-linux-unhandled-key.patch` hands a key a tab's page left unhandled to
  the host before the window gets it. For a key-down of Escape without Ctrl, Alt or Super, in a tab the window
  shows, the host sends that tab's page the Mac's `command` event `{command: "escape", text: ""}`
  (`ac_linux_page_keys.h`), which closes Peek and a Little Ardia window while the page has focus. Chromium still
  gets the key afterwards (it stops a loading page). An Escape that leaves full screen or a page that handles Escape
  never gets here. Advertised as `tab.unhandledEscape`.
- **App activation.** When an Ardia window loses activation and no other Ardia window (a Settings or Import window
  included) has it 150 ms later, every window's shell gets `ArdiaShell` `onAppEvent` `{type: "resignActive"}`, as
  the Mac sends from `didResignActive` (`AppActivation`, `ac_linux_app_activation.h`). A switch between Ardia
  windows sends nothing, and neither does a window closing while another takes over. While a native dialog of
  Ardia's is open the event is held back, as the Mac holds it during a modal or a sheet. The other half is the
  `focus` window event the host already sends when a browser window becomes active, which is what the shared UI
  listens for. Advertised as `ArdiaShell.resignActive`.
- **Small windows.** `ArdiaShell.openWindow` with `kind: "small"` and no `frame` now opens at `size` (`[width,
  height]`, 900 by 640 without one), at least 420 by 300 and at most 80 % of the work area of the opener's display
  each way (as on the Mac since #2784; the minimum wins on a smaller one), centred in it where the desktop has
  global coordinates (`RequestedSmallFrame`, and the shell's `smallWindowFrame` for older engines). A window that is small has the
  Mac's minimum size, 420 by 300, through `chromium-linux-window-minimum-size.patch`
  (`BrowserView::GetMinimumSize` asks the host). The new window's bootstrap carries `windowKind` (`"small"`,
  `"browser"`, or `"settings"`/`"import"`), and, when the opener passed a `smallWindow` object in the options (up
  to 1 MiB, refused for a private window), the same object as `smallWindow`, the way `privateWindow` travels. The
  shell uses both (`hostSmallWindows.ts`, `hostWindowProfiles.ts`) and keeps the `localStorage` handoff for older
  engines. Advertised as `ArdiaShell.smallWindows`.

### Problem reports

The engine serves the part of the Mac's `ArdiaReport` that needs no recording (`ac_linux_report.cc`, rules in
`ac_linux_report_core.cc`). It advertises `report.files` (drafts and gzip) and `report.send` (the requests), not
the method names: the shell sends a module method straight to a host that advertises it by name, and four of these
answer at once on the Mac and with a promise here, so the shell has to opt in.

- **The shell's side.** `hostReport.ts` sends the eight calls to the engine, each behind its capability
  (`appModuleFallbacks.ts` keeps the old answers without it), and `reportProblem.ts` opens the sheet. The shared code
  takes both kinds of answer through `platform/report.ts`, whose defaults are the Mac's: `removeReportFile` and
  `cancelUploads` ignore a promise's failure, `fileSize` answers -1 when the size isn't known at once (the size the
  draft recorded stands), `ensureDraftDir` awaits a promised folder, and `setReportPlatform` replaces the sheet's
  `fetch` with `ArdiaReport.post` and turns recording off, which hides the Record section (and with it the trace
  and the page choice). `ArdiaTelemetryLocal.exportForReport` gzips the last seven days of the IndexedDB copy into
  one draft folder with `gzipText`; the folder's path is kept in `localStorage` (`ardia.report.exportFolder`) and
  reused, so there is one export file at a time as on the Mac. The sheet's copy drops recordings and crash reports
  (`linuxWording.ts`).

- **Drafts.** `draftDirectory()` makes `<profile>/Ardia/Report Drafts/<uuid>` (mode 0700) and answers its path.
  Every other path a call names must lie inside one of those folders, as given and again after symbolic links are
  resolved; anything else is refused. `fileSize(path)` answers the size, or -1; `removeFile(path)` removes a file or
  a draft folder.
- **Gzip.** `gzipFile(source, destination, removeSource)` and `gzipText(text, destination)` write the same gzip
  stream as the Mac (zlib, level 6) and answer the bytes written. Text is capped at 64 MiB.
- **Sending.** The shell can't reach the network, so the JSON requests the Mac sends with `fetch` are a native call
  too: `post(url, body, headers)` for `https://ardia.dev/api/feedback` and `…/<id>/complete`, with a body of at most
  128 KiB. `upload(id, url, method, headers, path)` sends one draft file with `PUT` to
  `…/<id>/files/<name>`, where the name and its size cap are the service's (`recording.mp4` 100 MiB,
  `trace.json.gz` 50 MiB, `local-events.jsonl.gz`, `crash-<n>.ips` and `attachment-<n>.<ext>` 10 MiB), and
  reports progress as the `onReport` event `{type: "upload", id, sent, total}`. Only `X-Ardia-Key`,
  `Authorization: Bearer …` and `Content-Type` are sent. No other URL, method or header is accepted, requests carry
  no cookies and follow no redirect, and at most four run at once. Both answer the Mac's `{status, body, error}`: a
  refusal or a network failure is status 0 with the reason in `error`, and `cancelUploads()` ends every transfer
  with `error: "cancelled"`. A background instance sends nothing.
- **Not served.** Recording (`startRecording`, `stopRecording`, `cancelRecording`, `isRecording`,
  `recordingThumbnail`) and `ArdiaApp.diagnosticsSample`, and `ArdiaApp.crashReports` until the engine lists its
  dumps (Crash reports). The shell answers an empty sample, so a report's `footprint_mb` and `free_disk_gb` are null: the shell can read neither
  the app's memory footprint nor free disk space (`navigator.storage.estimate()` reports a quota, not free space).

### Ardia's notifications

`ArdiaApp.notificationPermission`, `requestNotificationPermission`, `postNotification` and `removeNotifications`
(`ac_linux_notifications.cc`, with the checks and the ledger in `ac_linux_notifications_core.cc`) show Ardia's own
notifications, such as a meeting reminder, through Chromium's Linux notification stack
(`NotificationDisplayService`, then `org.freedesktop.Notifications`), the one sites' notifications use.

- **Permission.** Linux has no per-app notification permission, so the status is `granted` and a request answers
  true. A background instance answers `denied` and false, and shows nothing.
- **Posting.** Options are the Mac's (`id`, `title`, `body`, `subtitle`, `silent`, `dismissible`, `tabId`, `windowId`,
  `data`); the answer is the id, or null when nothing was shown. `subtitle` becomes the body's first line. The title
  is cut at 1 KiB and the body at 4 KiB, on character boundaries; `data` is at most 16 KiB. `icon` and `origin` are
  ignored. At most 64 are tracked, and the oldest is closed to make room.
- **Type.** Chromium sends its generic notification type to its own in-app popups, not to the desktop. Ardia's
  notifications use `NotificationHandler::Type::NEARBY_SHARE`, which has no handler on Linux, and register Ardia's
  handler for it on the app profile's display service.
- **Responses.** A click sends `ArdiaApp`/`onNotificationResponse` (`{id, action: "click", tabId, windowId, data}`),
  closes the notification and activates the window. A close is reported (`action: "close"`) only for a `dismissible`
  one the user closed. The event goes to the window that posted, or to the most recently active browser window when
  that one is gone.

### The bang list

`ArdiaShell.fetchBangList(etag)` (`ac_linux_bang_list.cc`) fetches `https://services.helium.imput.net/bangs.json`, the
Mac's URL, from the browser process and answers the Mac's `{status, etag, contentType, body, bytes}`; `body` is set
only for a 200. No cookies, no cache, an `If-None-Match` only for an ETag of at most 200 bytes without control
characters, 5 MB and 60 s at most (the bridge allows 75 s), two fetches at a time. A redirect, a network error, a
larger reply or a 200 that isn't UTF-8 rejects with `ERR_BANG_LIST`; the Mac answers a redirect's own status instead.
A background instance rejects without fetching.

### Downloads and files

- **Choosers.** File and folder choosers go through `ui::SelectFileDialog`: the XDG portal, GTK or KDE, as Chromium
  picks. Each window has one chooser; a stale one is replaced and answered as cancelled. Background instances answer
  from `<user data>/file-chooser.txt` or cancel.
- **Show in Folder.** It tries, in order:
  1. the portal's `OpenDirectory`;
  2. `org.freedesktop.FileManager1.ShowItems`;
  3. `xdg-open` on the folder.
- **Trash.** Move to Trash follows the freedesktop spec per volume (`$topdir/.Trash/$uid`, else `.Trash-$uid`). It
  opens through handles and refuses symlinks.
- **Private downloads.** These always ask where to save, as Chrome's incognito does. They reach only their own window
  and are never kept.
- **Downloads panel presses.** `DownloadsPopover.tsx` counts any press inside the panel's region as inside the panel.
  The region and the panel's root are `box-none`, so only the panel itself takes hits there. Before #2155 the check
  looked for the full-window backdrop that #1610 removed. It found the panel instead, so every press in the panel
  counted as outside, closed it and lost the click.
  - A press outside closes the panel, and no part of that press reaches what it landed on, however long it is held
    and whichever button it is (a right-click's menu included). The swallow is its own listener, so it outlives the
    dismissal that closing the panel removes. It follows that press until its click, ends when the next press
    begins, and lets go 800 ms after the release if no click comes. Before, it went with the dismissal, and the
    release and click of the closing press switched tabs or pressed Clear All.
  - Escape still closes it.
  - While a row's menu is open, presses and Escape belong to the menu (`menuShown()` in `menus.tsx`). Escape closes
    only the menu, and choosing an item leaves the panel open. The menu renders under `document.body`, outside the
    panel's region, so `OutsidePressArea` ignores presses while a menu is shown too. A press on the shell outside both
    closes only the menu and goes on to what it landed on, as Linux menus do elsewhere; the panel closes on the next
    one. That holds for every Linux popover built on `OutsidePressArea`. A click in the page closes both at once,
    since the page taking focus closes every popover.
  - Acceptance F08 presses the header, a finished row (open file), Show in Folder, a row's menu (Escape, then Open),
    View all downloads, Pause, Resume, Cancel, Keep, Discard and Clear, with real CDP input in the packaged UI. Outside
    the panel it presses a toolbar button (Go Back, Go Forward or Reload) with a left and then a right press, and the
    click after the right-click has to land, so that button really acts once. A stand-in `xdg-open`
    records what Open and Show in Folder ask for. Progress and paused-byte samples come from the engine's
    `downloads.list`; live progress is stored separately from `s.downloads`.
  - Known bug: Clear removes the rows, but the panel opens again, empty. The engine posts `downloads.changed` for
    each removed item before `downloads.removed`, and `upsertDownload` takes it for a new download.
  - With sharing on, `usage_counts.linux_downloads_panel_inside_presses` counts pointer presses classified as inside
    and allowed through the Linux dismissal handler. Watch for that count to fall toward zero relative to panel
    opens if the handler starts misclassifying those presses again.

## Upstream syncs

Newest first. Each entry names the upstream commit `linux-support` was rebased onto and what the Linux side needed.

- **2026-11-13, upstream da8ac687f** (65 commits after 0134e00dc). One conflict, in the shared Live folder code:
  upstream added `markCompletedTabs` after a refresh and `hideStack` beside `releaseShownRepos`, which the Linux commit
  had folded into `applyFetch`'s write. Both of upstream's additions stay, and releasing shown repos stays inside the
  refresh's write, so the completion ticket isn't cancelled on Linux. Upstream's `chromium-restored-frame-gate.patch`
  came and went within the range, so the series is unchanged. The engine key moved from `1078820d892b` to
  `8562381ee0dd`; engine `engine-8562381ee0dd` is published, rebuilt incrementally at `-j 8` (13 steps). The link exports
  the same 63 dynamic symbols and no `ac_*`; the package passes all 12 smoke checks. Linux changes:
  - set viewport now works only on a tab the ardia command took into an off-screen automation window
    (`engine.cliMoveOffscreen`). Linux has no such window: `IsAutomationWindow` and `InAutomationWindow` answer false,
    `engine.cliMoveOffscreen`, `cliCloseOffscreenTabs` and `cliOwnsTab` answer that the call is unavailable on Linux,
    and set viewport stays refused over the token connection (see Known gaps).
  - The shown-slot record is a plain note again: `LayoutPane` notes a tab when it attaches it to a visible pane and no
    longer holds the page back.

- **2026-11-12, upstream 0134e00dc** (89 commits after 42c6291). Upstream moved the engine to Chromium 157.0.8103.50
  on Helium 0.21.2 and kept moving during the build, so the branch was rebased three times (2ff079b, 5ec3ed3, then
  0134e00) and the new engine commits were folded into the same out dir before its link. Two conflicts:
  - `engine/patches/build/helium-pins.ini`: upstream's helium-chromium 0.21.2 and helium-macos 0.21.2.1 pins, with
    `[helium-linux]` moved to 0.21.2.1 (`c594074e`), whose `helium-chromium` submodule is exactly 0.21.2 (`e817502a`);
    helium-linux changed only its packaging metadata. `HELIUM_LINUX_TAG` in `env.sh` follows.
  - the ardia `BUILD.gn`: upstream added `ac_cli_owned_tabs.{cc,h}` to the Mac-only list; the CLI sources build on
    Linux, so they join the shared list with the rest of them.

  The engine key moved from `087c111e94fc` to `1078820d892b`; engine `engine-1078820d892b` is published. The build tree
  moved to the .50 tag with `out/` set aside and put back (01-sync, then 03-helium, which needed helium-linux's
  initialized submodule updated to the pinned commit), and the series applied strictly (97 steps, 275 paths). Upstream's
  later edit to `chromium-drag-always-ends.patch` went into the tree through `series.py materialize`, which rewrote only
  the six files that differed. The link exports the same 63 dynamic symbols as before and no `ac_*`; the package passes
  all 12 smoke checks. Linux changes:
  - `ardia browse set viewport`'s shown-slot record (`ac_host_visibility_linux.cc`): `ShellHostView::LayoutPane` notes a
    tab when it attaches its contents to a visible pane, as the Mac web view does when it is visible in a window. A tab
    whose override is being cleared keeps its page hidden until the size is restored; with the page held back that
    usually ends at upstream's 250 ms deadline. Upstream gated set viewport over the token connection again for 0.2.46,
    so this path doesn't run in practice yet.
  - `ArdiaFocus.pressesWithoutRelease` and `pressRepeated` answer 0 and null: Linux has no macOS press tracker, so the
    lost-release and repeated-press tab counts stay 0 from Linux, as does `dragsEnded.nativeRefused`.
  - Wording follows Connect Another Device's new Show Code step and the new drag-end line in What's Sent.

- **2026-11-12, still upstream 42c6291: the sidebar peek's two-tone strip** (no rebase). jreyes138 reported on #622
  that the revealed strip sometimes looked two-toned with a non-Neutral accent. The peek draws its own window backdrop,
  the opaque display-p3 gradient, over a panel filled with the flat sRGB `windowTint[0]`. On Linux every
  `WindowBackdrop` registered as a page-hole layer, so the page rect was cut out of the peek's backdrop too. Over the
  page the panel showed through, and the strip split at the toolbar's bottom edge. The hole was also measured while
  the peek slid in and never again, so it landed 100 to 160 px off and split the strip side by side by a different
  amount each reveal. Saturated accents made the two fills different hues. Decision (owner): the peek keeps the
  opaque window gradient, as on the Mac, rather than turning translucent over the page. `SidebarDock` takes its
  `WindowBackdrop` from `glassUi.tsx` under `AbovePages`, and `usePageHoleLayer` skips such layers (`shellAbove.ts`).
  UI only: the engine key stays `087c111e94fc`. Verified in a headless Sway with `grim` on a real page, before and
  after: left sidebar in dark and light with orange, green and Neutral, and a right sidebar in dark and light with
  orange. After the fix every row across the strip matches within 1 per channel. No telemetry: a paint mismatch has
  no field signal.

- **2026-11-12, still upstream 42c6291: the sidebar-edge watch** (no rebase). jreyes138 reported on #622 that with
  Auto-hide tabs on and Sidebar position set to Right, the strip could never be revealed: the engine advertised only
  `ArdiaShell.watchLeftEdge`, so the shell turned the native watcher off for a right sidebar and fell back to its DOM
  watcher, which never sees pointer samples over the native page. The left-edge watch became a sidebar-edge watch
  with a side (`ac_linux_sidebar_edge.h`, `ArdiaShell.watchSidebarEdge`, the shared `sidebarEdge` event); see Windows,
  focus and input › Sidebar-edge peek. The window controls now follow `setTrafficLightsCenter`'s `trailing` flag. The
  engine key moved from `756f755c2bf0` to `f9a19cc5aa34`. Verified with the C++ fixture on both sides, the host tests,
  and on the built engine in a headless Sway with a virtual pointer (the real Aura root path): the right strip, the
  hold column over the page and leaving the column behave as on the left, and the left side is unchanged. That harness
  can't exercise the Wayland leave-and-settle path on either side (no flick revealed the left sidebar on the previous
  engine either), so the 90 ms settle on the right is covered by the fixture only. Telemetry: `sidebar_peeks` now also
  counts right-side peeks on Linux.

- **2026-11-12, upstream 42c6291** (77 commits after 39bd206). Three conflicts: `engine/patches/series` (upstream's new
  `chromium-pref-hash-safe-storage-key-change.patch` stays shared, beside the two Mac-only Safe Storage patches; it
  touches only `services/preferences` and applies to the Linux tree unchanged), the shared source list in the ardia
  `BUILD.gn` (gains `ac_extensions_load_health.cc` and `ac_search_suggest.cc`, which build on Linux), and the Linux
  telemetry hunks in the onboarding and new-tab ask files that upstream rewrote. The engine key moved from
  `e3f26f7253b3` to `756f755c2bf0`. Linux changes:
  - `extensions.loadHealth` is routed to `ac_extensions_load_health`, so `extensions_loaded` reports from Linux.
  - Google suggestions moved to `www.google.com/complete/search?client=chrome`; the native allowlist
    (`ac_linux_suggest_policy.h`) and the F10 fixture follow it. Linux keeps its own `ArdiaSearch.suggest` (no cookies,
    the endpoint allowlist) rather than upstream's `search.suggest`, which sends the profile's cookies to any URL. The
    Linux fetcher counts `search_suggest_ok` and `search_suggest_failed`; `search_suggest_blocked` stays 0.
  - Onboarding is three steps, and the default browser and Dock questions moved to the last one. Its probes refuse on
    Linux, which left Get Started disabled; a failed probe now leaves its row out. `LinuxHomeStep`, which replaced the
    old home step's first screen with a Linux default-browser question, is gone: that screen is now the links question.
  - Wording follows the scroll bar row to `appearanceRows.ts` and the new LookStep and What's Sent lines.
- **2026-11-11, upstream 39bd206** (78 commits after e2c7577). The rebase applied without conflicts and the engine key
  stayed `e3f26f7253b3`, so engine `engine-e3f26f7253b3` still matches. The Linux symbol set gained `pip`, which the
  tab row now draws for a tab in Picture in Picture, and `paperclip`, which Report a Problem used before. The new
  `ArdiaLocation` module answers `granted` on Linux, which has no app-wide location switch, so allowing a site's
  location never shows the macOS System Settings dialog. Upstream's Dock-reopen, hover-lost and macOS auto-PiP
  telemetry never fire on Linux; What's Sent says "the system" where those lines named macOS. The link status bubble
  stays at the bottom (see Known gaps).

## Known gaps

These were open at the time of the PR.

- **Shared calls Linux doesn't route yet:**
  - bookmarks HTML export (`bookmarks.exportHtml`). Until an engine advertises it, the shell serves the call itself
    (`hostBookmarksExport.ts`): it builds the file from `bookmarks.tree` and `favicons.get` in Chromium's own
    bookmark-file format (`bookmarksHtml.ts`) and downloads it from the shell page, so it lands in the Downloads
    folder as `Ardia Bookmarks.html`, follows Ask where to save each file, and shows in the downloads list. There is
    no Save dialog of its own, a folder's `LAST_MODIFIED` is its newest child's date (the tree carries no
    modification date), and the downloads list keeps the entry;
  - the `extensions.installFailed` event. The Mac sends it when a `.crx` dropped on the window fails to install
    (`ArdiaHostEngineDelegate.mm`); Linux has no dropped-`.crx` install to fail, so it needs that install path first;
  - performance recording (`engine.beginTracing`, `endTracing`, `isTracing`). It isn't a shared service: the Mac's is
    Objective-C in its own layer (`engine/ardiacore/src/ardia/core/ardiacore_engine_tracing.mm`, about 150 lines over
    `content::TracingController`, which Linux has too). Its only caller is the problem report sheet's slow-page
    recording, which Linux never opens (see Report a Problem), so a port would advertise a call nothing uses. Port it
    with the report sheet.
- **Profiles.** Deleting the data of an engine profile that was loaded in this run waits for the next launch
  (Profiles and private windows › Deleting a profile's data). In a window that shows several engine profiles:
  - a page's own fullscreen in a companion's tab makes only its viewport fullscreen, not the window;
  - Chrome's own download bubble and other toolbar-anchored bubbles of a companion have no visible anchor (Ardia's
    downloads panel lists them); the downloads list a window loads at start comes from its own profile, while later
    downloads, controls and file operations reach the window from every profile it shows;
  - a window Chrome itself creates for an isolated profile (`chrome.windows.create` from that profile's extension)
    is still a plain Chrome window, as before;
  - a shell renderer may send a strip command for another window's strip, which that window's host refuses
    (`The strip is not owned by this window`); the owning window's renderer keeps its own strips in order;
  - that a companion never maps a second toplevel has been confirmed on X11 only, not on Wayland.
- **Tab drags across windows.** There is no floating drag preview; in-window drags show the ghost row. On Wayland,
  where windows have no global coordinates, tearing a tab off or dropping it on another window does nothing. On X11 a
  tab dropped on another window is appended rather than placed at the pointer's row.
- **Wayland focus.** A keyboard switch right after a window maps can be undone. A quit within about 200 ms of moving
  a fullscreen window to another output can save the old output.
- **Closing the last window during a download** shows Chromium's own download dialog, not an Ardia dialog.
- **Window menu.** It has no Arrange in Front, Keep on Top or Profiles submenu.
- **Window corner radius.** `ArdiaAppWindows.windowCornerRadius` answers a fixed 19 (`shellMethods.ts`), the Mac's
  default, so the page card keeps its 10 pt radius at the default inset. Linux doesn't measure the compositor's
  rounding.
- **Auto-hide tabs** is one setting, as upstream made it. Linux saves no `sidebarOpen` per window: `linuxSessionShape`
  reads an older session's copies to set the setting, then drops them from saved and closed windows. The launch-time
  `windows_realigned_to_auto_hide_tabs` count stays 0 on Linux, which doesn't load through `loadSession`.
- **Field timing.** `platform/fieldTiming.ts` binds the macOS-only `NativeModules.ACFieldTiming`, which is undefined
  on Linux, so `journeys.ts` threw `Cannot read properties of undefined (reading 'lastInput')` from a store update and
  Enter in a new tab's address bar did nothing (Fedora 44, wlroots). Linux replaces the module with
  `apps/linux/src/fieldTiming.ts`, which reports no timing data (`lastInput` is `[0, 0]`, `drain` is empty), so the
  field journeys send no samples from Linux. UI only; the engine key is unchanged.
- **Settings rows without a backend are hidden**, each until the host advertises its capability
  (`unavailableSettingIds` in `hostCapabilities.ts`): Zoom with Ctrl and the mouse wheel
  (`webView.setCommandScrollZoom`), Keep new-tab links inside a Little Ardia window
  (`webView.setLittleArdiaOpensNewTabLinks`), Open a Peek window when clicking on links to other sites
  (`webView.setPeekOtherSiteTabs`), Scroll bars (`ArdiaSystem.setThinScrollBars`), all four advertised by the
  current host, Haptic feedback when reordering tabs (`ArdiaSystem.hapticTick`), and the two rows
  about links from other apps, Open links from other apps in Little Ardia and Put links from other apps first
  (`ArdiaShell.onOpenURLs`, which the host advertises now that it sends that event; an older engine leaves such
  links to Chromium, which opens them as tabs). The command bar's Dictate button follows `ArdiaShell.startDictation`
  the same way. With an older engine the app menu's Open Links from Other Apps entry, its row in Keyboard Shortcuts
  and the sentence about links from other apps under Open new-tab links in are left out too (`unavailableCommands`,
  `settingsForm.tsx`). Calendar › Show alerts is hidden until a host posts Ardia's own notifications
  (`ArdiaApp.postNotification`), and the commands that need WebKit or AppleScript (Open Page in WebKit, Allow
  JavaScript from Apple Events) have no menu entry or shortcut row.
- **Session migrations.** The saved Linux session carries the shared `version`. `linuxSessionShape` runs the shared
  `SESSION_MIGRATIONS` from that version on the shape the Mac saves (windows, tabs, groups and splits as lists), and a
  session without the stamp counts as version 9, the last one Linux's own shape checks cover. A migration that changes
  something is saved at launch against what was on disk. A session from a newer build is left as it is, and its stamp
  is written down to this build's on the next save; as on the Mac, downgrades aren't supported.
- **Default browser.** An Ardia that isn't installed where the desktop looks (an extracted folder, a prefix outside
  `XDG_DATA_DIRS`) still shows the default browser controls, and they answer false; the reason is only in the log.
  `xdg-settings` is the only backend: a desktop without it can't be asked or set.
- **Links from other apps.** The source app is never known, so link rules that match on the app don't apply, and a
  Little Ardia window opens where the compositor puts it rather than at the pointer. Whether the window that takes
  a link comes to the front on Wayland depends on the launch's activation token reaching `ArdiaShell.focusWindow`,
  which hasn't been checked on a real desktop. Links that arrive while a window exists but its shell never listens
  (a shell that failed to load) wait until one does.
- **Not compiled yet.** The pointer hand-off, the unhandled Escape, app activation, small windows, the extension
  popup's focus and the problem report calls (the two sections above Ardia's notifications) are written against
  the Chromium 157 headers with fixture tests and have not run in a built engine.
- **Little Ardia.** With an engine older than `ArdiaShell.smallWindows` the native window has no minimum size of
  its own, and with one older than `tab.unhandledEscape` Escape closes the window only from its blank command bar
  and when nothing in the shell has focus, not while the page has focus (Peek's Escape too). Pinch
  and swipe to close have no Linux gesture.
- **Meeting notifications.** Calendar › Show alerts › Always posts only while Ardia isn't active. With an engine
  older than `ArdiaShell.resignActive` the shell is never told, and only the in-window alert appears. Any focused
  Ardia toplevel (a browser window, a PiP window, a dialog) counts as Ardia being active. Coming back
  to Ardia through a Settings or Import window sends no `focus` window event, so the shell counts Ardia as inactive
  until a browser window is active again.
- **Problem reports.** The sheet opens only with an engine that advertises `report.files` and `report.send`, and
  has no recording, trace or crash reports. The engine only accepts `https://ardia.dev/api/feedback`:
  there is no override for a local feedback server, and a background instance sends nothing, so the sheet can't be
  exercised end to end from a hidden instance yet.
- **Crash reports.** Only x86-64 dumps get frames, and frames are named only from the symbols archive the engine was
  published with (`scripts/linux/symbolize.py`). An engine older than `crash.dumps` answers no crash reports.
- **Casting.** Real Cast devices haven't been tried: the build network has none, so casting has run against the test
  sink only. Mirroring a tab or the screen to a real device is Chromium's own Cast mirroring service, unchanged.
- **Ardia's notifications.** A desktop without a notification service falls back to Chromium's own popups, as sites'
  notifications do. A click activates the window through the same Wayland activation path as above.
- **Launch at login** starts Ardia as any launch does; it doesn't start hidden. A system-wide
  `/etc/xdg/autostart/ardia.desktop`, which Ardia doesn't install, is neither read nor overridden.
- **Ctrl-scroll zoom off** (`webView.setCommandScrollZoom`) stops the zoom, and the wheel then does nothing; on the
  Mac the page scrolls instead. A site that handles Ctrl-scroll itself still gets it either way.
- **Links to other sites and new-tab links** (Links in pinned tabs and Little Ardia windows). None of it has run in
  a built engine yet. A site click the shell never answers (a shell that hangs after the host sent it `openWindow`)
  is lost, as on the Mac. A window is a Little Ardia window only once its shell has opened it as one
  (`kind: "small"` in `ArdiaShell.openWindow`); new-tab links there open as tabs until then, and in every other
  window they are reported at once, without the Mac's `fromClick`, `point` or `linkWait`, so Open new-tab links in
  Peek or Little Ardia still doesn't apply on Linux.
- **Link status bubble.** The pointer's place is the last one Chromium saw in this window. With an older engine the
  status carries no `fromBottom` and the bubble stays at the bottom.
- **Scroll bars.** Follow the system and Thin look the same on a desktop whose GTK setting already prefers overlay
  scroll bars, which is GTK's default. Thin needs Chromium's `OverlayScrollbar` feature, on by default here; with it
  turned off by a flag the setting does nothing.
- **Hardware details.** The GPU name and the hardware decoders are empty until Chromium's GPU process has reported,
  and a software renderer reports none. The chip is `/proc/cpuinfo`'s `model name`, which some ARM kernels leave out.
- **Small UI bugs.**
  - A sidebar hover card stays open when a test moves the pointer from the sidebar into the page with DevTools
    input, which never tells the shell the pointer left (Pointer hand-off). A real pointer closes it.
  - A played video removed from the DOM keeps its media entry until the element is collected.
- **Not available on Linux:**
  - casting with an engine that doesn't advertise all six cast calls (`media.showCastDialog`, `startCasting`,
    `stopCasting`, `closeCastDialog`, `watchCastRoutes`, `terminateCastRoute`): Cast shows a toast;
  - translation (Bergamot isn't ported yet);
  - video upscaling;
  - installing updates: Ardia checks for them and opens the release page (Updates and kill switches);
  - crash reports with an engine that doesn't advertise `crash.dumps` (see Crash reports);
  - sending problem reports from the sheet with an engine older than `report.files` and `report.send` (see Problem
    reports), where `ArdiaTelemetryLocal.exportForReport` answers null;
  - notification icons, and a notification settings page to open (`openNotificationSettings`);
  - the share sheet;
  - Handoff;
  - AppleScript;
  - alternate app icons;
  - holding incoming links at launch for a link rule, and moving a finished download out of the default folder
    (`ArdiaSystemSignals.holdsIncomingLinks`, `moveCompletedDownload`), which still answer from
    `appModuleFallbacks.ts`.
- **Packaging.**
  - There is no AUR package yet; the `PKGBUILD` builds from a local tarball.
  - An AppImage can't carry a setuid helper, so where user namespaces are restricted (Ubuntu 24.04 and later
    without Ardia's AppArmor profile) it refuses to start, like the tarball, and says to install the `.deb` or allow
    user namespaces. The `.deb` and `install.sh` set the sandbox up.
- **Sync.** One read has no total size cap (each file is capped at 64 MiB). Linux and macOS sharing a real folder has
  not been run end to end with a Mac.
- **Shared, not Linux-specific.** The Google Drive OAuth flow uses `Math.random` state, plain PKCE and a loopback
  URL that lands in tab state. This is shared with macOS and unchanged here.
- **Widevine.** It comes from the component updater as software L3. The first DRM playback after the CDM downloads
  needs a restart.
- **Checks that need a person.** No automated suite covers these:
  - real provider accounts;
  - a real GNOME Online Accounts calendar;
  - desktop password managers;
  - a polkit agent's own dialog;
  - touchpad pinch.
