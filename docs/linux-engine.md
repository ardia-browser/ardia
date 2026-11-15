# Ardia on Linux, on the engine

Today's Linux port (`docs/linux.md`) runs the shared UI in Electron. This is the design for running it on Ardia's own
engine instead, the one the Mac and Windows builds use: Chromium 157.0.8103.50 with Helium 0.21.2 (helium-linux
0.21.2.1) and our patch series, built by `scripts/linux/engine` into `~/chromium-build-linux`. It covers the process,
the UI host and its bridge, windows, pages and input, focus and keys, menus and dialogs, the new home of every main
process module, launching, the sandbox, packaging, test instances, the risks, and a work breakdown with a first
milestone. Nothing here is built yet (2026-11-15). The Electron build keeps working until the engine build reaches its
parity, and is then removed.

The short version:

| Layer | Electron today | On the engine |
| --- | --- | --- |
| Process | Electron's main process (Node) | Chromium's browser process, started with no window (`--no-startup-window`); `//ardia/linux` is our code in it |
| UI | One hidden `BrowserWindow` renders the bundle | One hidden `WebContents` loads the bundle as a WebUI, `chrome://ardia-app/`, served from disk |
| App windows | `window.open` children of the host, in frameless `BrowserWindow`s | `window.open` children of the host, each in a frameless `views::Widget` of ours |
| Bridge | `window.ardiaLinux` from a preload, Electron IPC | The same `window.ardiaLinux`, installed by our renderer code in the host frame only, over Mojo |
| Pages | `<webview>` elements in the UI's DOM | Real Chrome tabs: a viewless `Browser` per profile per app window, each shown tab's native view inside the app window's widget, under the UI |
| Drawing over pages | DOM order | The UI's `WebContents` sits above the pages with a transparent background; an input region sends each point to the page or the UI |
| Chrome services | TypeScript in the main process | Chrome's own, through the `ac_*` calls; the Windows domain tables answer the UI |
| Native modules | TypeScript in the main process | C++ in `//ardia/linux` on Chromium's pieces, or TypeScript in the UI's renderer where no native access is needed |

## Process

The product is Chromium's own `chrome` binary (renamed `ardia.bin` in the package) with `//ardia/linux` linked in, as
Windows links `//ardia/win` into `chrome.dll`. There is no second executable and no app library: on Linux the app's
native side is engine code, and the app's JavaScript runs in a renderer.

- `chromium-linux-app-in-browser-process.patch` (Linux only, `series-linux`) links `//ardia/linux` into
  `//chrome:chrome` and changes `ChromeMain`'s delegate on Linux to `ardia_linux::MainDelegate`, a
  `ChromeMainDelegate` (the same edit `engine/ardiacore/apply.sh` makes for the Mac's `ACMainDelegate`, under
  `BUILDFLAG(IS_LINUX)`). It also calls `ardia_linux::BeforeChromeMain()` first, in every process, like Windows'
  `BeforeChromeMain`.
- `BeforeChromeMain` reads the launch variables once (`ARDIA_DATA_DIR`, `ARDIA_BACKGROUND`,
  `ARDIA_REMOTE_DEBUGGING_PORT`, `ARDIA_INSTANCE`, `ARDIA_SWITCHES`, `ARDIA_TRACE`, `ARDIA_TEST`, `ARDIA_UI_DIR`,
  `ARDIA_FEEDBACK_URL`), decides the test gate (below), and turns them into switches as Windows' `main.cc` does:
  `--user-data-dir=<data>/Chromium`, `--no-startup-window`, `--no-first-run`, `--no-default-browser-check`, the
  `--ardia-*` switches `ac_launch_switches` reads, `--class=ardia`, and in a test instance the debugging port. It drops
  the switches that open the profile to an outsider outside a test instance, as Windows and the Mac do. The engine
  reads no variable after this point; everything downstream reads switches.
- The data folder is `$XDG_DATA_HOME/ardia` (or `ARDIA_DATA_DIR`), Chromium's profile `<data>/Chromium`, as on the
  Mac and Windows. Chrome's own default (`~/.config/chromium` or Helium's) is never used.
- `MainDelegate` supplies `ardia_linux::ContentBrowserClient` (a `ChromeContentBrowserClient`) and
  `ardia_linux::ContentRendererClient` (a subclass of the Mac's `ACContentRendererClient`, which is plain C++ and
  compiles on Linux, see "What is shared"). The browser client adds the bridge's binder, the navigation guards, the
  host's popup rule and the WebUI factory; the renderer client adds the bridge object and keeps the Mac's page script.
- A `ChromeBrowserMainExtraParts` of ours starts the app once the browser has started (`PostBrowserStart`): it takes a
  `ScopedKeepAlive` (Chrome would quit with no browser windows), starts `Host`, the module registry and the UI host.
  Quitting is ours: `app.quit` and the last window run the UI's quit handshake, then release the keep-alive and call
  `chrome::AttemptExit`.

## What is shared, and how the series script shares it

`series_linux.py layer` assembles three of our layers in the tree. It imports `series_win.py` (it already does, for
the patch machinery) so the copy rules are one code.

**`//ardia/win`'s platform-neutral files, copied verbatim.** Shivam's files are never edited in the repo; the Linux
layer copies them into the tree's `ardia/win/` (same paths, same `ardia_win` namespace, so their includes resolve
unchanged), overlays three Linux files, and applies one small patch to the copies.

| File | On Linux |
| --- | --- |
| `tab_state.{h,cc}`, `tab_events.{h,cc}` | Compiled as they are. They include `ardia/win/host.h` and `api.h`, which the Linux overlay provides |
| `tab_calls.h`, `page_links.{h,cc}`, `page_links_script.h` | Compiled as they are |
| `private_sessions.{h,cc}`, `external_apps.{h,cc}`, `api.h`, `ac_calls.h`, `profiles.h` | Compiled as they are |
| `tab_calls.cc`, `profiles.cc` | Need `ardia-win-on-linux.patch`: three lines convert `FilePath::value()` with `base::WideToUTF8`/`UTF8ToWide`, which don't compile where `FilePath` holds `std::string`. The patch uses `AsUTF8Unsafe()`/`FromUTF8Unsafe()`, which mean the same on Windows; offer it to Shivam and the patch goes away |
| `ac_calls.cc` | Generated, by `series_win.engine_calls_source()` |
| `host.h` | Linux overlay (`scripts/linux/engine/src/ardia/win/host.h`): includes `ardia/linux/host.h` and says `namespace ardia_win { using Host = ardia_linux::Host; }`. The shared files use seven members of `Host` (`Get`, `Shows`, `BrowsersOf`, `CloseBrowsersOf`, `ForgetProfile`, `DeleteClosedTab`, `TabDestroyed`); `ardia_linux::Host` has them with the same signatures |
| `hooks.h` | Linux overlay: declares `g_ardia_win_external_protocol_dialog` and `g_ardia_win_relaunched` with no Windows types (the shared `external_apps.cc` sets the first) |
| `BUILD.gn` | Linux overlay: `source_set("shared")` over the files above, plus `launch_switches` from `//ardia/core` as Windows builds it |
| `host.{h,cc}`, `api.cc`, `main.{h,cc}`, `test_gate.{h,cc}`, `frame_view.{h,cc}`, `probe/` | Not copied. Windows code (HWNDs, Win32 regions, DPAPI paths); Linux has its own `host`, `api`, `main` and `test_gate` in `//ardia/linux`, and no frame view (Linux browsers have no `BrowserView`) |

`api.cc`'s Linux twin defines the `ardia_win::Emit`, `Error`, `EngineApi` and `WatchEngineEvents` the shared files call:
`Emit(topic, payload)` becomes a bridge event (module `ArdiaEngineHost`, event `event`, `{ topic, json }`), which is
what `packages/expo-windows/src/engine/host.ts` listens for, and `hostCall`/`engineCall` are the bridge module's two
methods.

Two Windows patches are about OS-neutral seams and apply to the Linux tree with their `BUILDFLAG(IS_WIN)` guards
widened to `IS_WIN || IS_LINUX` (a new `win-widened <patch>` line kind in `series-linux`, the rewrite done by
`series_linux.py` before `git apply`): `chromium-win-external-protocol-dialog.patch` (the external app prompt) and
`chromium-win-relaunch-to-app.patch` (a second launch reaches the app). Ask Shivam to make both guards OS-neutral and
rename the hooks without `win`; then the widening goes.

**`engine/chromium` (`//chrome/browser/ardia`, the `ac_*` calls) built on Linux.** Today `series-linux` runs
`apply.sh` and leaves the layer unbuilt, and applies `chromium-win-ardia-layer-calls-mac-only.patch`. The design needs
it built: every Chrome service the UI reaches goes through it. `series_linux.py` makes its Linux `BUILD.gn` with
`series_win.ardia_build_file()`'s rules (`assert(is_linux)`), keeps `pip/` (Dia's Picture in Picture window is a
`VideoOverlayWindowViews` subclass; its Mac presenter is the one `.mm` left out), applies Windows' `ardia-layer-win.patch`
only where it isn't about drive letters (paths from UTF-8 hold on Linux as is; the POSIX-only files Windows swaps out,
the `ardia` command's control file and the scripts policy, are POSIX and build here), and links it into
`//chrome:chrome` (`chromium-linux-ardia-layer.patch`, the Linux counterpart of `chromium-ardia-layer.patch`). Then
`chromium-win-ardia-layer-calls-mac-only.patch` leaves `series-linux`, so the Scripts policy providers and Dia's PiP
window are in.

**`//ardia/core` (`engine/ardiacore`), selected portable files.** `apply.sh` stays Mac only, as on Windows. The Linux
layer copies: the hook headers (`ac_hooks.h`, `ac_content_hooks.h`), `ac_launch_switches.{h,cc}` (through
`series_win.launch_switches_source()`, its log line pointing at `ardia/linux/test_gate.cc`), and the renderer side of
the Mac's page channel: `renderer/ac_content_renderer_client.{h,cc}`, `mojom/ardiacore.mojom`, `ac_page_limits.h`,
`ac_page_script.{h,cc}` (about 600 lines of C++ with no Cocoa). The browser side of that channel (`ac_page_channel.mm`)
gets a C++ twin in `//ardia/linux/page_channel`.

**The OS-neutral hooks in `apply.sh`.** A viewless Browser needs hooks that `apply.sh` writes into cross-platform
Chrome files: H1 (`browser.cc`, the Browser takes our window), H2 (`browser_window_features.cc`, our
`WebContentsDelegate`), H3 (the permission prompt factory), and the CHECKs made tolerant of a Browser without a
`BrowserView` (`sad_tab_controller.cc`, `read_anything_side_panel_controller.cc`, `toast_controller.cc`,
`browser_commands.cc`, `autofill_popup_controller_impl.cc`, `tab_dialog_manager.cc`, `browser_window_util.cc` and the
extension hooks). The Mac runs viewless Browsers through the same Views code Linux compiles (Mac Chrome is Views over
remote Cocoa), so these are exactly the Linux needs. `series_linux.py hooks` runs the `hook` blocks of `apply.sh` named
in `scripts/linux/engine/linux-hooks`, one name per line, through `apply.sh`'s own Python helper (extracted from the
file at run time, so markers, `--check` and the include line behave identically) without copying Mac code and without
editing `engine/` (which `engine-key.sh` hashes). Left out: `chrome/BUILD.gn`'s `chrome_dll`, `chrome_main.cc` (Linux has
its own patch), `chrome_browser_main_mac.mm`, the Bluetooth and memory-pressure Mac files. H5/H6's
`chrome_main_delegate.cc` block is taken: `g_ardia_embedder` is what makes Chrome's startup ours on Linux too.

**The UI's TypeScript.** `packages/expo-windows/src/engine/**` is platform-neutral React and TypeScript except four
imports (`./host`, `../modules`, `../animation/motion`, `../../nativeModuleTypes`'s TurboModule types). The Linux
engine bundle reuses it as is (EngineWebView, `usePageCover`, covers and clips, `pages.ts`, `pageEvents.ts`,
`privateWindows.ts`, and every domain table in `domains/`); a Vite resolver in the engine bundle's config swaps those
four modules for Linux ones (`packages/expo-linux/src/chromium/`). Each replacement is type-checked against the module
it stands in for (`satisfies typeof import(...)`), so a change on the Windows side that breaks Linux fails
`pnpm -C apps/browser/linux typecheck:chromium`, not at run time. The import readers
(`packages/expo-windows/src/import`), the sync TypeScript (`src/sync`: layout, listing, QR code, Recovery Kit) and the
launch link filter (`src/launchLinks`) are reused the same way.

## The UI host

**What it is.** A `WebContents` of the original profile, owned by `ardia_linux::UiHost`, never in any Browser's tab
strip (so `chrome.tabs`, session restore and the task manager's tab list don't see it), loading
`chrome://ardia-app/index.html`. `chrome://ardia-app` is a WebUI (`ArdiaAppUI`, a `content::WebUIController` registered
by a `WebUIConfig`) for three reasons: its renderer is a WebUI process, locked to that origin and never shared with a
web page; web pages can't navigate to it; and Chrome already treats `chrome://` as trusted where content settings
apply (pop-ups, clipboard). An extension page (`chrome-extension://`) was considered and rejected: it would put the UI
inside the extension system, with extension APIs and Web Store semantics it doesn't need.

**Its files come from disk, not from a pak.** `ArdiaAppSource` (a `content::URLDataSource`) serves the UI bundle from
`<app dir>/ui/` (the package's), or `ARDIA_UI_DIR` in a test instance, on a blocking pool, with the path resolved and
confined to that folder (no `..`, no symlink out). So a UI change is a Vite build, never an engine build, as the Mac's
Metro and Windows' bundle folder work. Its CSP is ours (`OverrideContentSecurityPolicy`): `script-src 'self'
'wasm-unsafe-eval'` (Bergamot), Trusted Types off (React Native Web writes styles and text the way it does on the web),
`connect-src` for the release feed and the translation registry, `frame-src` for the meadow's sandboxed `srcdoc`
frame. `chrome://ardia-app/translations/...` serves the cached translation models (below).

**Never hidden to its renderer.** A `WebContents` that isn't shown is backgrounded by Blink: timers drop to once a
second and, after five minutes, once a minute. The app's one runtime lives in the host's document, so the host holds a
capturer (`WebContents::IncrementCapturerCount(size, stay_hidden=false, stay_awake=false)`), the same way
`ac_cli_visible_tabs.cc` keeps a tab visible to its renderer. It has no compositor of its own (its view is in no
widget), so `requestAnimationFrame` on the host would never fire: `host/acrossWindows.ts` already answers the host's
window for its app windows, and the engine bundle adds `requestAnimationFrame`/`cancelAnimationFrame` to what it
forwards, to the most recently shown app window's, falling back to a 16 ms timer when none is shown (the same answer
Electron's `backgroundThrottling: false` gave).

**App windows are `window.open` children.** As today, `ArdiaAppWindows.openWindow` asks the native side to shape the
window (`shapeWindow(id, options)`), calls `window.open('about:blank', id)`, mounts `AppRegistry.runApplication("main",
{ windowId })` into the child's `#root`, and asks to show it after the first paint. In Chromium that child is created by
`RenderFrameHostImpl::CreateNewWindow` in the host's BrowsingInstance and process (an `about:blank` popup without
`noopener` inherits the host's origin), so the host scripts its document synchronously, as on Electron (Electron is
Chromium here). `ChromeContentBrowserClient::CanCreateWindow` (157) puts no WebUI limit on it; it only runs the popup
blocker, which our browser client skips for the host's `WebContents` (and only for `about:blank` under a name
`shapeWindow` just shaped, each name used once, as `navigationGuards.ts` does today). The host's delegate gets
`WebContentsCreated(..., frame_name, ...)` with the window id, then `AddNewContents`, where it hands the child to
`AppWindows::Adopt(id, std::unique_ptr<WebContents>)`.

**Navigation guards** are a `NavigationThrottle` our browser client adds for the host and its children: the host
commits only `chrome://ardia-app/` documents (its frames `about:blank` or `about:srcdoc`), each app window only
`about:blank`, an app window opens nothing, and refusals go to `launch.log` with the scheme only. The host's delegate
also refuses `OpenURLFromTab` and downloads.

**Reloads.** `ArdiaDev.reloadUi` (test instances) and the engine bundle's watcher (`dev:engine`, below) close every app
window and reload the host; the UI restores the session as at launch, and launch links wait for it again, as on
Electron.

## The bridge

The contract stays exactly today's `LinuxBridge` (`modules`, `call`/`callRaw`, `callSync`/`callSyncRaw`, `onEvent`,
`pathForFile`), so `packages/expo-linux/src/bridge.ts`, `modules.ts`, `events.ts` and the fall-through order
(`aroundMain`, main modules, `writtenInTs`, engine modules, services, `defaults.ts`, inert) don't change. A module the
engine doesn't have yet falls through to the TypeScript layers or the defaults: the UI boots with a handful of native
modules, which is what makes the first milestone small.

**Why not plain Mojo from JavaScript.** WebUI pages get Mojo through the generated TypeScript bindings, and those have
no synchronous calls: `[Sync]` only exists for C++ callers. So the bridge object is C++ in the renderer:

- `ardia_linux.mojom.AppBridge` (`ardia/linux/ui_host/mojom/app_bridge.mojom`):
  `[Sync] Modules() => (string json)`, `[Sync] CallSync(string module, string method, string args) => (string reply)`,
  `Call(string module, string method, string args) => (string reply)`, `SetClient(pending_associated_remote<AppBridgeClient>)`;
  `AppBridgeClient.Event(string module, string event, string json)`. It is channel-associated
  (`RegisterAssociatedInterfaceBindersForRenderFrameHost`), so replies and events keep their order with navigation.
  Arguments and replies are JSON strings, parsed once on each side; a reply is `{ value }` or `{ error, code }`, what
  `callSyncRaw`/`callRaw` already return.
- In the renderer, `ContentRendererClient::RenderFrameCreated` attaches `AppBridgeFrame` to a main frame in a process
  with WebUI bindings, and on `DidCreateScriptContext` for that frame's main world, when its URL is
  `chrome://ardia-app/...`, installs `window.ardiaLinux` (a `gin::Wrappable`) before any page script runs. `callSync`
  makes the C++ sync call; `call` returns a promise resolved when the reply arrives; `onEvent` keeps the listeners and
  calls them from `AppBridgeClient.Event` inside the frame's context. Only that one world of that one frame gets the
  object: app windows are `about:blank` documents the host scripts, and all the app's JavaScript runs in the host's
  realm, so they need nothing (on Electron they had only the `<webview>` preload).
- In the browser, the binder binds `AppBridge` only for the host `WebContents`' primary main frame, checked by
  identity (not by origin: an app window's `about:blank` shares the host's origin), and every call checks again that
  the sender is that frame with that committed origin; anything else gets `ERR_LINUX_BRIDGE_SENDER`, logged once per
  sender, as `ipcSenders.ts` does. A host that navigates to a new document gets a new receiver.
- `ModuleRegistry` (`ardia/linux/ui_host/modules.{h,cc}`) is `defineModule` in C++: each module registers its sync and
  async methods (`base::RepeatingCallback`s over `base::ListValue` args, replying `base::Value` or an error with a code)
  and its constants, and emits events with `Emit(module, event, payload)`. `Modules()` returns the shapes with the
  constants, so `modules()` and every constant are answered by the first sync call.

**Sync calls.** Today's sync methods are reads of state main already holds (window shapes, document reads, launch
links waiting, counts, focus state) plus `ArdiaDocuments.writeDocument`, which stages. They stay sync, under two rules
the registry enforces: a sync handler answers from memory on the UI thread and never waits on a renderer (the caller's
renderer is blocked; waiting on any renderer could deadlock), and never touches the disk (documents and config files
are read into memory by a pool task started before the host loads; a sync read of one not loaded yet waits on that one
task, which the host's load is ordered after). A sync method whose answer never changes becomes a constant
(`windowCornerRadius`, `notificationCenterPath`, `languageName`, which becomes `Intl.DisplayNames` in TypeScript).
Telemetry counts sync calls and those over 4 ms (`linux_engine_sync_calls`, `linux_engine_sync_slow`, hourly
`usage_counts`), so a slow one shows in the field.

## Windows

`ardia_linux::AppWindow` is one app window: a `views::Widget` (`TYPE_WINDOW`, `remove_standard_frame`,
`opacity = kTranslucent`, `wm_class_name`/`wm_role_name` `ardia`, Wayland app id `ardia`) whose contents view is
`AppWindowView`, holding the page views and, on top, the UI's `views::WebView` with the child `WebContents`.

- **Shape and frame.** `shapeWindow`'s options give size, minimum size, kind (browser, Little Ardia, Settings, Import,
  pop-up) and `animated`. Windows are rounded (12 px, a 1 px edge) except maximized or full screen, drawn by the UI
  over a transparent widget. Where X11 has no compositing manager (no `_NET_WM_CM_S0` owner, so no ARGB visual), the
  widget also gets `Widget::SetShape` with the rounded rectangle, which X11 applies with the Shape extension: corners
  are cut, not black as on Electron.
- **Showing.** The window stays unmapped until the UI says `showWindow` after its first paint, then fades in over
  0.25 s (Little Ardia 0.20 s) with `Widget::SetOpacity` when `animated` or not a browser window, as Windows does; a
  background instance shows without activation (`ShowInactive`).
- **Moving.** The UI keeps `-webkit-app-region: drag` and `windows/dragCover.ts`: the renderer reports draggable
  regions (`WebContentsDelegate::DraggableRegionsChanged`, which Chrome uses for borderless PWAs on Linux), and
  `AppWindowFrame::NonClientHitTest` answers `HTCAPTION` inside them and `HTCLIENT` elsewhere, so the window manager
  moves the window (`_NET_WM_MOVERESIZE` on X11, `xdg_toplevel.move` on Wayland), snaps it and maximizes on a double
  click. Edges answer the resize components when not maximized. Regions that take clicks move the window from native
  with `Widget::RunMoveLoop`, which Chrome's tab dragging uses on both. A right press on a drag region becomes a
  `contextmenu` event to the UI, as `system-context-menu` does today.
- **Window manager calls.** Minimize, maximize, restore, full screen, focus, bounds and the work area are `Widget`'s.
  `windowClose` from the window manager asks the UI (`closeRequest`) for browser and Little Ardia windows.
- **The quit handshake.** SIGTERM, SIGINT and SIGHUP (Chrome's own handlers in `ShutdownDetector` call
  `chrome::AttemptExit`, which our keep-alive and an `ApplicationLifetime` observer turn into `willQuit` first), the
  last window closing and `app.quit` send `willQuit`; the UI saves and answers `replyToTerminate`; the engine exits, or
  exits anyway after 3 s.

## Pages

**Browsers.** As on the Mac: one `Browser` per profile per app window (private windows: the profile's off-the-record
profile, named `incognito:<window>@<profile>` as Windows names them), made with `BrowserWindowCreateParams::window`
set to `ardia_linux::BrowserWindow`, our implementation of Chrome's `BrowserWindow` with no `BrowserView`, tab strip or
toolbar. It is a C++ port of the Mac's `ACBrowserWindow` (`ac_browser_window.{h,mm}`, `_exclusive_access.mm`,
`_keyboard.mm`, `ac_location_bar.mm`, `ac_find_bar.mm`, `ac_autofill_bubble_handler.mm`, `ac_web_contents_delegate.mm`,
`ac_modal_dialog_host.mm`: about 1,800 lines, of which only the window glue is Cocoa; the rest is Chrome's C++
interfaces). `g_ardia_browser_window_factory` (H1) also makes it for a Browser Chrome opens by itself (a pop-up, an
extension's `chrome.windows.create`), which `Host` then adopts. Windows hosts real `BrowserView`s instead (page-only
top-level windows, `chromium-win-hosted-*`), which can't share the app window's widget on Linux, so Linux follows the
Mac here, not Windows.

**`Host`** (`ardia_linux::Host`) answers the same verbs as Windows' (`tab.create`, `tab.show`, `tab.close`,
`tab.call`, `tab.discard`, `tabs.list`, `host.info`, `keyboard.forget`, `peek.config`, `tab.links`,
`profile.release`, `app.quit`), with `tab.call`'s methods answered by the shared `tab_calls.cc` and the events sent by
the shared `tab_state.cc`/`tab_events.cc`, so `packages/expo-windows/src/engine` drives it without a change. The
window argument is the UI's window id. It differs where Windows is about windows:

- `tab.show { key, visible, x, y, width, height, radius, holes }` puts the tab's `views::WebView` (one per shown tab,
  kept by `Host`) into the app window's `AppWindowView` at that rect, in the UI's points (the UI and the widget share a
  device scale factor), under the UI's view. A rounded page gets `SetNativeViewCornerRadii` on the WebView's holder (the
  call Chrome's `ContentsContainerView` uses for its rounded contents in 157), a layer clip done by the compositor.
  `visible: false` hides the view and the tab goes hidden to its renderer.
- Several pages show at once (Split View, a Peek) as several WebViews; only one tab is the Browser's active tab (the
  one the keyboard last went to), the others are shown views. Chrome decides a tab's visibility from its view, not from
  the tab strip, so both panes render and both count as visible to the page.
- A tab moving to another app window moves its `WebContents` into that window's Browser (`TabStripModel`'s detach and
  insert, as `MoveTab` does on Windows) and its view into the other widget. Chrome reparents a tab's native view between
  widgets for tab dragging; the page keeps running, its history and scroll state, with no reload and none of
  Electron's `navigationHistory.restore`.
- Discarding is Chrome's (`tab.discard`, and Memory Saver's own timer: `chromium-memory-saver-pinned-tabs.patch`
  applies).
- Pop-ups with features come from Chrome as a `Browser` of type popup; `Host` shows its tab in a `PopupWindow`
  (`windows/popup_window.cc`), a Views window with the system frame and the Mac's origin strip (connection glyph,
  origin, "Open as Tab"), as the Mac's native `ArdiaPopupWindow` does. Open as Tab sends `tab.opened` for the live tab
  to the opener's window. Windows shows a bare Chromium window today.

**Holes mean the reverse of Windows.** Windows cuts holes in a page window where a UI surface covers it, because the
page is above the UI. On Linux the UI is above the page and draws there anyway; the same `holes` (from `usePageCover`,
which every shadowed surface already reports, clipped by `ClipView`s) say where the UI takes input over a page. No new
UI protocol, and a surface that fades or grows over a page shows the page under it, not the card (a Windows limit that
goes away).

## Drawing over pages and routing input

The UI's `WebContents` has a transparent background (`WebContents::SetPageBaseBackgroundColor(SK_ColorTRANSPARENT)`,
its view's layer not filling its bounds opaquely), and sits above the page views in the same widget, so everything is
one compositor: the command bar, popovers, toasts, the window's rounded corners and the card's shadows draw over
pages with no holes. Chrome stacks a WebUI `WebContents` over a tab's contents in one widget for the Lens overlay
(`LensOverlayController`'s `overlay_web_view_`), so the stacking itself is ordinary; a transparent one over a live page
is what the milestone proves first.

**Input region.** `InputRegion` (one object per app window) knows each shown page's rect, corner radius and holes from
`tab.show`. A point goes to the page under it when it lies in a page's rounded rect and in none of that page's holes;
otherwise to the UI. Chromium 157 has two paths that pick a window for a point, and both must use it:

- Mouse, touch, gesture and wheel events are targeted by `aura::WindowTargeter`. The UI's `WebContents` window gets
  an `InputRegionTargeter` whose `EventLocationInsideBounds` is false outside the UI's region, so targeting falls
  through to the page's window below.
- Drag and drop (`DesktopDragDropClientOzone` calls `root_window->GetEventHandlerForPoint`) and anything else using
  `aura::Window::GetEventHandlerForPoint` don't consult the targeter: they ask each parent's delegate
  `ShouldDescendIntoChildForEventHandling` and the window's `HitTest`. `AppWindowWidget` (a `views::Widget`) overrides
  `ShouldDescendIntoChildForEventHandling` with the same region, so drops land on the page or the UI exactly where
  clicks do.

A press on a page counts as a press outside every popover of its window (`pagePress`, from the shared `tab_state.cc`),
as on Windows. Chrome's own popups for a page (autofill dropdown, `<select>`, color and date pickers) are separate
widgets anchored to the page's view, so they sit above everything.

**Not routed by views hit testing.** A `RenderWidgetHostViewAura` gets its events from aura, not from the views tree, so
a container view's `GetEventHandlerForPoint` or `TargetForRect` would never decide which page gets a click; the region
lives in aura's targeting and the widget's descend check.

**IME, focus, accessibility.** Each `WebContents` is a `RenderWidgetHostViewAura` in the same widget; the one with focus
is the widget's `TextInputClient` (`InputMethodAuraLinux`), as Chrome's omnibox and page share a window, so IME
composition follows focus with nothing of ours. Accessibility: the widget's tree holds the UI's and each page's
`WebContents` as children of `AppWindowView`, in the order they are stacked; AT-SPI exposes them as Chrome exposes its
own window.

**The fallback**, if a transparent `WebContents` over a page fails in 157 (it composites opaque, or the page's frames
lag behind the UI's by more than a frame during a move): Windows' arrangement inside the same widget. Page views go
above the UI's view, the UI shows through where pages aren't, and each page is clipped around the cover rects
(`ui::Layer` clip for rectangles, a mask layer for rounded holes). It keeps the one widget and one compositor, keeps
the same `tab.show` data, and inherits Windows' known limits (a translucent surface shows the card in its hole).

## Focus and keyboard

- Focus is the widget's `FocusManager` and aura's focus client: clicking a page gives its `RenderWidgetHostViewAura`
  focus, clicking the UI gives the UI's. The keyboard rules Windows follows (`state/focus/keyboardFollows.ts`: a page
  never takes the keyboard because it shows; a tab switch or a Peek asks its page to follow unless an app text field
  has it) arrive as `tab.call` `focus` and `keyboard.forget`, and `Host` gives focus with `WebContents::Focus()`, only
  when the keyboard is already in that app window and Ardia is the active app, never in a background instance.
- **Shortcuts, pages included.** The command table stays TypeScript (`apps/browser/linux/src/menus`'s
  `commandTable.ts`, `keys.ts`, `keyboard.ts`, `store.ts` move into the engine bundle). The UI resolves it, with the
  user's remapped shortcuts, the window kind and whether an app text field has focus, into a flat key map and sends it
  to `ArdiaMenus.setKeyMap` whenever it changes. `ardia_linux::KeyMap` matches every key event in
  `WebContentsDelegate::PreHandleKeyboardEvent`, of the UI's `WebContents` and of every page (our delegate, from H2),
  by DOM code plus modifiers: a match is consumed (`kHandled`) and sent to the UI as `ArdiaMenus` `command`; a key the
  map marks page-first returns `kNotHandledIsShortcut`, so the page sees it first and it runs from
  `HandleKeyboardEvent` only if the page didn't take it. Chrome's own accelerators never run in our windows (we
  register none, and our `BrowserWindow` answers no accelerator). Escape a page leaves unhandled reaches the UI as the
  page's `command` `escape`, from the shared `tab_state.cc`. The sync rule holds: the match reads only the key map and
  focus state the browser already has.
- **Focus coming back after a dialog.** Ported from `focusReturn.ts` and `system/xFocus.ts` to C++ on Chromium's own X11
  client (`x11::Connection`, which already holds the display and the Xauthority cookie): when a dialog closes or a
  focused app window closes and nothing of ours has focus 100 ms later, the parent or last focused window is
  activated, only if `_NET_ACTIVE_WINDOW` (under a window manager) or the input focus (without one) is None, the root or
  ours. Wayland needs none of it.

## Menus and dialogs

- **The app's menus** (`ArdiaMenus.showMenu`: the … menu, tab menus, the sidebar's) are `views::MenuRunner` over a
  `ui::SimpleMenuModel` built from the UI's items, anchored to a rect in the app window, with shortcut labels from the
  key map. A background instance writes them to `activation.log`/`menu.json` and takes `menu.json.pick`, as the Mac's
  `ARDIA_TEST appMenu` does.
- **Page context menus** are Chrome's (`RenderViewContextMenuViews`) first, which already anchor to our widget because
  the page's view is in it. Then `chromium-linux-context-menu-hook.patch` lets `//ardia/linux` make the menu, and
  `prompts/context_menu.cc` arranges Chrome's model as the Mac's `ac_context_menu.mm` does (its ordering is Chrome
  model work, portable), so Linux keeps the Mac's items in the Mac's order, which Electron has today.
- **File pickers** are `ui::SelectFileDialog`, owned by the app window: Chromium on Linux uses the desktop portal when
  it answers and GTK otherwise, as Electron did. A background instance answers from `file-chooser.txt` and logs that a
  file was chosen, never which.
- **confirm and alert** are Views message boxes (`chrome::ShowQuestionMessageBox`-style `MessageBoxDialog`), window
  modal to the app window; `prompt` stays the app's own. Every dialog goes through `SystemDialogs`, which also runs
  the focus return above.
- **Pages' JavaScript dialogs, print preview, `beforeunload`, permission chips' fallbacks** are Chrome's tab-modal
  dialogs, which need a `WebContentsModalDialogHost`: our `BrowserWindow`'s modal host (the port of
  `ac_modal_dialog_host.mm`) gives the app window's view and positions them over the page's rect. They are child
  widgets of the app window, above the UI.
- **The owner's password prompt** (Unlock, Export CSV, the recovery phrase) becomes a Views dialog in the browser
  process (`modules/owner_prompt.cc`: a `views::DialogDelegate` with an obscured `Textfield`, "Ardia wants to show your
  saved passwords."), so the password never enters a renderer; it goes from the field into a zeroed buffer and to
  `unix_chkpwd`.

## Chrome's own UI for pages

With no `BrowserView`, Chrome has nowhere to anchor its bubbles, so, as on the Mac, the hooks our series already has
hand them to the app, and the UI draws its own prompts (the Electron build draws all of these today):

| What | Hook (already in `engine/patches` or `apply.sh`) | On Linux |
| --- | --- | --- |
| Offer to save a password | `chromium-password-bubble-hook.patch` | `prompts/passwords.cc` sends the Mac's `passwordPrompt` page event; `passwords.resolvePrompt` answers |
| Permission prompts | H3 `permission_prompt_factory.cc` | `prompts/permissions.cc`, a `permissions::PermissionPrompt` sending `permissionRequest`; `permissions.resolve` (Windows lists it as missing) |
| Save address and card | `chromium-autofill-address-bubble-window.patch`, `ACAutofillBubbleHandler` | The port's `AutofillBubbleHandler` sends `autofillPrompt` |
| Extension install | `chromium-extension-install-prompt-hook.patch` | `prompts/extension_install.cc`: the app's Add dialog with the permissions; `extensions.resolveInstallPrompt` |
| Extension action popups and side panels | the action popup and `chromium-side-panel-hook.patch` hooks | An `ExtensionViewHost` in a Views bubble anchored to the rect the UI reports for the toolbar's extension button |
| External apps | `chromium-win-external-protocol-dialog.patch` (widened) | The shared `external_apps.cc` and `domains/externalApps.ts`; `ArdiaExternalApps.describe`/`open` in C++ over `xdg-mime query default` and the desktop file's name and icon, `open` with `xdg-open` (Chrome's own `platform_util::OpenExternal` path) |
| Docked DevTools | `chromium-window-docked-devtools.patch` | DevTools first opens undocked, as on Electron; then `prompts/devtools_dock.cc` places the DevTools `WebContents` beside the page inside its rect with Chrome's `DevToolsContentsResizingStrategy` |
| Picture in Picture | `chromium-pip-overlay-window.patch` | Dia's `ArdiaVideoOverlayWindow` from `chrome/browser/ardia/pip/` (Views, built on Linux), so the restyled window, remembered frame and close-never-pauses come with it; Electron couldn't |
| Find | none needed | The app's find bar through `tab.call` find and the `find` events; our `BrowserWindow` makes no Chrome find bar |
| Downloads | none needed | Chrome's download bubble needs a toolbar we don't have; the app's panel from the `ac_downloads_*` events (`domains/downloads.ts`) |
| Context menu | `chromium-linux-context-menu-hook.patch` | Above |

The engine-side handlers in the table are written without any X11 or GTK, in `ardia/linux/prompts/`, so Windows can
take them later for the rows `forwarded.json` lists as missing.

## The page channel

The Mac runs `page_script.js` in every http(s) and file frame from its renderer client and receives its posts over
`ACPageHost`; Linux reuses that renderer code as is (above) and adds `page_channel/` in the browser, a C++ twin of
`ac_page_channel.mm` and `ac_page_channel_held.mm`, which turns posts into `pageMessage` page events and sends
`ACPage.CallPage`/`Execute`/`Evaluate`. That brings theme colours, scroll, selection, now playing, badges and Peek and
split links as the Mac has them. Until it lands, the shared `page_links.cc` (Peek through a DevTools session and an
isolated world, Windows' way) gives Peek; once it lands, the Linux app sends the Peek modifiers to one of the two only,
so a link never opens two Peeks.

## Every module's new home

**Main process modules** (`apps/browser/linux/src/modules`, `src/*.ts`):

| Module | New home | Why |
| --- | --- | --- |
| `ArdiaApp`, `ArdiaLinuxHost` | C++ `modules/app.cc`; version and build as constants | Reads the package's build file and `version_info`; constants need no call |
| `ArdiaAppWindows` | C++ `windows/app_windows.cc` | Widgets |
| `ArdiaDocuments` | C++ `modules/documents.cc` | Files: staged in memory, written with `base::ImportantFileWriter` semantics (temp file, flush, rename) one at a time, newest wins, flushed synchronously at quit, as today |
| `ArdiaConfig` | C++ `modules/config.cc` | `base::FilePathWatcher` (inotify) |
| `ArdiaKeychain` | C++ `modules/keychain.cc` | Sealed with Chrome's own `os_crypt_async` `Encryptor` (libsecret, KWallet or the basic key, Chrome's `--password-store` choice), stored per item under `<data>/Keychain`; `protection()` answers the backend |
| `ArdiaDialogs` | C++ `modules/dialogs.cc` | `ui::SelectFileDialog`, message boxes |
| `ArdiaMenus` (menus, key map) | C++ `modules/menus.cc`, `keys.cc`; the table in TypeScript | Above |
| `ArdiaFocus` | C++ `modules/focus.cc` | Text-field focus state for the key map, `takeKeyboardFromPage`, focus return |
| `ArdiaShell` | C++ `modules/shell.cc` | `platform_util::OpenExternal` and `ShowItemInFolder` (Chrome's D-Bus file manager call), trash through GIO (`g_file_trash`; glib is already linked), appearance from `ui::NativeTheme` (Chromium follows the portal's `color-scheme`), clipboard through `ui::ScopedClipboardWriter` (text, images, files as `text/uri-list` for the Recovery Kit) |
| `ArdiaNotifications` | C++ `modules/notifications.cc` | Chrome's `NotificationDisplayService` (transient notifications, Chrome's freedesktop D-Bus bridge), clicks back as `onNotificationResponse`; a background instance logs them |
| `ArdiaSystem` (default browser, open at login) | C++ `modules/system.cc`, `desktop_entry.cc` | Chrome's `shell_integration` on Linux runs `xdg-settings` with `CHROME_DESKTOP=ardia.desktop`; the AppImage's desktop file and icons and the autostart entry are ours, ported from `desktopEntry.ts`; a test instance writes under `<data>/Desktop` and runs nothing (and `chromium-linux-background-instance-no-default-handlers.patch` is the Mac patch's counterpart in `shell_integration_linux.cc`) |
| `ArdiaSystemSignals` (lock, sleep) | C++ `modules/screen_lock.cc` on `//dbus` | logind's `Lock`/`LockedHint`/`PrepareForSleep` and the screen savers' `ActiveChanged`, ported from `screenLock.ts`; `base::PowerMonitor` on Linux reports no suspend |
| `ArdiaLocation` (GeoClue) | C++ `modules/location.cc` on `//dbus` | A `device::LocationProvider` over GeoClue2, given to Chrome's geolocation through `chromium-linux-location-provider.patch` (a custom provider getter where Chrome sets its geolocation configuration); Chrome's own permission and the app's prompt decide, with no DevTools override |
| Owner check (`ownerCheck.ts`, `ownerPrompt.ts`) | C++ `modules/owner_check.cc`, `owner_prompt.cc` | `unix_chkpwd` with the same trust rules, waits, generations and zeroing; `chromium-linux-reauth-owner-check.patch` makes Chrome's own password export reauth (`DeviceAuthenticator` on Linux) ask it, as Windows' `chromium-win-reauth-app-window.patch` does with Windows Hello |
| `ArdiaLaunchLinks` | C++ `modules/launch_links.cc`; filter in TypeScript | Chrome's process singleton (below); the rule is `expo-windows/src/launchLinks`' |
| `ArdiaLinuxFileDrop` | C++ `modules/file_drop.cc` | Our browser client's `WebContentsViewDelegate` for the host's children sees each drop's `DropData` (paths, URLs, text); areas report frames and the innermost enabled one under the pointer gets it, as Windows' `FileDropTarget.h` does. `pathForFile` reads the same `DropData` |
| `ArdiaLinuxEdgePointer` | C++ `modules/edge_pointer.cc` | `display::Screen::GetCursorScreenPoint` every 40 ms while watched |
| `ArdiaTelemetryLocal`, `ArdiaLinuxCounts`, `ArdiaExternalAppCounts` | C++ `modules/telemetry_local.cc`, counts in the modules that count | Files |
| `ArdiaReport` (problem reports, recording) | C++ `modules/report.cc`, `recording.cc`; recorder in TypeScript | C++ gathers logs and uploads to `ARDIA_FEEDBACK_URL` with `network::SimpleURLLoader`; the recording registers the app window as a capture source (`DesktopMediaID::RegisterNativeWindow`), the UI renderer records it with `getUserMedia` and `MediaRecorder` (MP4, H.264) and blacks out page rects it knows, and C++ saves the bytes. The pill is an app window |
| `ArdiaUpdater` | TypeScript in the UI renderer | A `fetch` of the GitHub releases feed and `ArdiaShell.openURL`; nothing native until the app updates itself |
| `ArdiaTranslate` | TypeScript worker in the UI renderer; C++ `translate/models.cc` | Bergamot's WASM runs in a dedicated worker of the UI renderer with today's queue and caps (`translate/engine.ts`, `pieces.ts`); models are fetched, hashed while streaming (`crypto::SecureHash`), gunzipped and cached by C++ (the same registry, catalog and checks), and the worker loads them from `chrome://ardia-app/translations/<pair>/<file>`. Page language comes from Chrome's own CLD3 detection (`translate::LanguageDetectionObserver`, sent as a tab event), not `cld3-asm`. Page text goes in and out through the page channel |
| `ArdiaSync` | C++ `sync/` (keys, crypto, files); TypeScript from `expo-windows/src/sync` | Windows' native half ported from BCrypt and DPAPI to BoringSSL (`crypto::HkdfSha256`, `crypto::hmac`, `crypto::Aead`) and `os_crypt_async`, so keys and passwords never reach JavaScript, as on the Mac and Windows; files confined to the sync folder |
| `ArdiaImport` | C++ `import/` primitives; TypeScript readers from `expo-windows/src/import` | Listing and reading inside browser profile roots, a read-only SQLite snapshot (`//sql`), Chromium's v10 and v11 keys (libsecret through Chromium's wrapper, KWallet), NSS `key4.db` (Windows' `ImportNss.h` on BoringSSL), cookies and autofill decrypted straight into `ac_cookies_import`/`ac_autofill_import` JSON under one-time tokens, as Windows does |
| `ArdiaCli`, `ArdiaScripting` (not on Linux) | TypeScript stand-ins in the UI renderer | Nothing native |
| `ArdiaDev` | C++ `modules/dev.cc`, test instances only | `snapshotWindow` (a `CopyOutputRequest` on the widget's root layer: UI and pages composited), pointer and key injection into the widget, `reloadUi` |
| `quit.ts`, `launch.ts`, `paths.ts`, `log.ts`, `crashes.ts` | C++ `main.cc`, `app_lifetime.cc`, `log.cc` | Process |
| `navigationGuards.ts`, `ipcSenders.ts`, `appDocument.ts`, `preload.ts`, `bridge.ts` | C++ `ui_host/` | Above |
| `secretStorage.ts` | Gone | Chrome's `os_crypt` is the one secret store |
| `introMusic.ts`, `build.ts`, `files.ts` | Gone or constants | The music is a file in `ui/`; the rest is packaging |

**Electron's `engine/`** (pages as `<webview>`): all of it goes, replaced by Chrome and the shared engine code.
`sessions.ts`, `partitions.ts`, `userAgent.ts`, `guests.ts`, `pageCalls.ts`, `opening.ts`, `popupWindows.ts`,
`popupBlocker.ts`, `pageKeys.ts`, `pageDialogs.ts`, `leavingPages.ts`, `printing.ts`, `errorPages.ts`,
`taskManager.ts`, `memorySaver.ts`, `downloads.ts`, `permissions.ts`, `contextMenu.ts`, `pictureInPicture.ts`,
`widevine.ts`, `blockedCounts.ts`, `hostDomains.ts`, `domains.ts` and `hostPreload.ts`/`pagePreload.ts` are Chrome's
own features (tabs, pop-up blocker, JavaScript dialogs, `beforeunload`, print preview, the network error page and the
lamb game, the task manager, Memory Saver, downloads, permissions, PiP) driven through the shared verbs, events and
`ac_*` calls. `geolocation.ts` and `dbus.ts` become `modules/location.cc` and `//dbus`. `pageScriptBridge.ts` becomes
the page channel.

**Electron's `services/`** (Chrome's services in TypeScript): all go. History, favicons, bookmarks, passwords,
autofill (`pageAutofill.ts`, `autofillFrames.ts`, `pagePasswords.ts`), site settings and zoom, search suggestions,
browsing data, profiles and profile data, extensions (`electron-chrome-extensions`, `electron-chrome-web-store`,
`crx.ts`, `extensionSenders.ts`, the updater) are Chrome's own through the `ac_*` calls, answered in the UI by the
Windows domain tables (`expo-windows/src/engine/domains`, with `desktop.ts`'s dialogs and file reads given Linux
answers). `database.ts` (`node:sqlite`) has nothing left to store. `contentBlocker.ts` (Ghostery) goes: the Mac's
blocker is engine side (uBlock Origin loaded as a component extension), so Linux ships uBO in the package
(`/opt/Ardia/Extensions/ublock`) and loads it the Mac's way, with `content_blocker.cc` porting the engine calls of the
Mac's `ArdiaContentBlocker*.mm`. `import/` and `sync/` move as above.

**What stays TypeScript, and where.** In the UI renderer: the shared UI, `packages/expo-linux` (React Native Web
views, `host/`, `windows/`), the command table, the domain tables, import readers, sync layout and kit, translate's
worker and queue, the updater, the recorder. Nothing in the engine build runs on Node.

## Launching and relaunching

- **A second launch** is Chrome's process singleton (`ProcessSingletonPosix`: the `SingletonLock` in the profile and
  its socket), so the data folder decides which instance a launch reaches, as `ARDIA_DATA_DIR` does on Electron. The
  widened `chromium-win-relaunch-to-app.patch` hands its command line to `//ardia/linux`, which sends `relaunch` with
  the web and file addresses, and the UI opens them as links from another app; a launch with none brings the last
  window forward, `--new-window` opens one.
- **A first launch's links** are read from the process's command line (`Exec=ardia %U` gives each as an argument), kept
  by `expo-windows/src/launchLinks`' rule, and held until the UI listens, as both ports do.
- **Relaunch after an update or a crash** is Chrome's `chrome::AttemptRestart`, which re-executes the binary with the
  original command line.

## Sandbox

Chromium's own. The decision stays in a shell function before the binary starts, because Chromium aborts when the
setuid helper is present but not setuid root and user namespaces are unusable: `apps/browser/linux/packaging/sandbox.sh`
(today's, shared by both builds) picks unprivileged user namespaces when the kernel allows them and AppArmor doesn't
restrict them (or a profile grants `userns` to the binary), else the setuid-root `chrome-sandbox` beside it
(`CHROME_DEVEL_SANDBOX`), else `--no-sandbox` with the reason in `launch.log`. The `.deb` installs `chrome-sandbox`
setuid root and an AppArmor profile granting `userns` to `/opt/Ardia/ardia.bin`; the AppImage can't carry a setuid
helper and is sandboxed where user namespaces work. `--no-sandbox` is in the test gate's dropped list outside a test
instance unless the launcher decided it, which it says with `--ardia-sandbox-decision=<why>`.

## Packaging

`scripts/linux/engine/06-package.sh` already packs an out dir into Chromium's CI snapshot shape
(`linux-archive-rel.json`). The app package is made from that and the UI bundle, by a new
`scripts/linux/package-engine.mjs`:

- `/opt/Ardia/`: Chromium's runtime files with `chrome` as `ardia.bin`, `chrome-sandbox`, `ui/` (the engine bundle,
  no source maps), `Extensions/ublock`, the `ardia` launcher (`sandbox.sh`, `CHROME_DESKTOP=ardia.desktop`, then
  `exec ardia.bin`), `ardia.build.json` (version and build from `scripts/version.mjs`).
- `ardia.desktop` (`StartupWMClass=ardia`, the `http`/`https`/`text/html` handlers, a New Window action) and the icons,
  from the files `apps/browser/linux/packaging` has for Electron, moved so both builds use them.
- `.deb` with `dpkg-deb` (its `postinst` and `prerm` from today's), AppImage with `appimagetool` (`AppRun` is the
  launcher). Both for x64 and arm64.
- Widevine: see Risks. The CDM isn't in the package either way.

## Test instances

- **The gate.** `test_gate.cc` (Linux) decides once, before Chromium starts, as Windows' does: an absolute
  `ARDIA_DATA_DIR` whose real path (and its `Chromium` folder's) is not, inside or around `$XDG_DATA_HOME/ardia`,
  `$XDG_CONFIG_HOME/ardia` or their defaults (today's rule from `launch.ts`), held open with `O_PATH|O_DIRECTORY|O_NOFOLLOW`
  for the life of the process and checked again through the descriptors, and a test build: an `ardia.test-build`
  marker beside the binary, which the smoke and CI write and the packaging refuses (the same reasoning as Windows:
  nothing is signed). Only then do `ARDIA_TEST`, `ARDIA_TRACE`, `ARDIA_UI_DIR` and the debugging port count.
- **Running one.** `scripts/linux/test-instance` gets `--engine <dir>` (an unpacked engine package, or the out dir
  with `ui/` beside it): it starts the launcher on its own Xvfb and private D-Bus session bus
  (`scripts/linux/xvfb`, unchanged), with `--ozone-platform=x11`, `ARDIA_BACKGROUND=1`, its own data folder and port,
  waits for `/json/version` and prints the pid; `--stop` runs the quit handshake.
- **Driving it.** CDP reaches the host (`chrome://ardia-app/index.html`, where the dev harness `ac` lives, as on
  Electron), each app window's `about:blank` child and each page. `scripts/linux/capture` takes each app window's
  composited picture with `ArdiaDev.snapshotWindow` (UI and pages together; a CDP screenshot of an app window shows
  only the UI layer) and each page's with CDP. Real input is `xdotool` on the Xvfb, as the Electron walk used.
- **`pnpm -C apps/browser/linux dev:engine`** builds the engine bundle with `vite build --watch` into a scratch
  `ARDIA_UI_DIR` and runs a test instance on it; each rebuild reloads the host.

## How the two builds coexist

- `apps/browser/linux/src/**` is the Electron main process and stays as it is until removal.
- `packages/expo-linux`: the backend-neutral files (`bridge.ts`, `modules.ts`, `events.ts`, `defaults.ts`, `host/`,
  `windows/`, `views/` except the page view, `web/`, `reactNative/`) serve both. The Electron backend is `src/engine/**`
  (`<webview>` pages) and `src/services/modules.ts`. The engine backend is `src/chromium/**` (the four modules swapped
  into `expo-windows/src/engine`, the engine modules and domain tables, `followMotion` for the web, the key map pusher,
  the requestAnimationFrame forwarding). Where a file differs by backend, its engine twin sits beside it as
  `<name>.chromium.ts(x)` (`engine/modules.chromium.ts`, `services/modules.chromium.ts`, `views/registry.chromium.tsx`),
  picked by the engine bundle's `resolve.extensions` and by `tsconfig.chromium.json`'s `moduleSuffixes`, the way
  `*.linux.ts` platform files are picked today.
- `apps/browser/linux/renderer/vite.config.ts` builds `ui/` (Electron); `vite.chromium.config.ts` builds `ui-chromium/`.
  `package.json` gets `build:ui:chromium`, `typecheck:chromium`, `dev:engine`, `package:engine`.
- `PLATFORM_FEATURES` rows that differ by backend (Translate, extensions in private windows, site access) read a
  `linuxBackend` constant from `ArdiaApp`, so one `platformFeatures.linux.ts` serves both.
- Telemetry's system profile gets `linux_backend` (`electron` or `chromium`) so the dashboard splits Linux by build.
- CI: `.github/workflows/linux.yml` keeps its Electron jobs; a `linux-engine.yml` fetches a prebuilt engine (as
  Windows' `prebuilt.json` does), builds the engine bundle, packages, and runs the engine smoke on Xvfb.
- **Removal**, once the engine build walks the 64 rows of `docs/linux.md` at least as well: delete
  `apps/browser/linux/src`, `packages/expo-linux/src/engine`, `src/services`, the Electron Vite config, the Electron and
  Electron-library dependencies, the `.chromium` suffixes (each twin becomes the file) and the Electron CI jobs, and
  rewrite `docs/linux.md` from this file.

## Risks, and how each is retired

| Risk | How it's retired |
| --- | --- |
| A transparent UI `WebContents` over a live page doesn't composite as one (opaque, or the page lags the UI by a frame while it moves) | The first milestone's first check. Moves during animations are measured with the Peek's grow and the sidebar's slide (frame difference on a 60 fps capture). If the page lags, `tab.show` gets the animation's target, curve and length and the page moves by a `ui::LayerAnimator` in the browser's compositor instead of a rect per frame. If transparency fails, the fallback above |
| `window.open` children of a WebUI aren't scriptable or don't share the host's process in 157 | A WebUI that opens one child and writes into it, before anything else is built. Fallback: the host on a custom privileged scheme (`ardia-app://` through `RegisterNonNetworkNavigationURLLoaderFactories`, an isolated origin with a dedicated process) with the same bridge binder |
| Input routing misses a path (drag and drop, wheel, touch, tooltips, cursor) | Both aura paths use one `InputRegion`; the milestone's checks press, scroll and drop a file on a page and on the command bar over it with real X input |
| Sync bridge calls stall the UI or deadlock | The registry's two rules (memory only, never wait on a renderer), the slow-call counter, and a test that every sync method answers under 2 ms with a cold cache |
| The hidden host's timers and frames are throttled | The capturer hold and the rAF forwarding; the milestone logs the host's timer rate and frame rate over a minute |
| A Chrome feature dereferences the missing `BrowserView` on a Linux-only path (the Mac's patches cover the shared ones) | Run every `IDC_*` command through `chrome::ExecuteCommand` on a viewless Browser in a test instance, plus the walk; each crash gets a "without-browser-view" patch in the series, the shared kind if the path is shared |
| Shivam's `//ardia/win` files change and stop compiling on Linux, or the widening stops applying | `series_linux.py` fails loudly; Linux engine CI compiles the layer on each change to `scripts/windows/engine/src/ardia/win`. Retired for good when the three path lines and the two hook guards are OS-neutral upstream |
| Keys: a shortcut a page should get first, or IME composition eaten by the key map | The key map skips events with `is_composing` and keys during composition; `shortcuts-test` ported to the engine (every command in every focus, pages included) |
| Wayland: no global positions (Little Ardia, pop-ups 60 px below their opener), no focus control, different move and resize | First ship on X11 and XWayland (`--ozone-platform=x11` in the launcher when `XDG_SESSION_TYPE=wayland` and `DISPLAY` is set), then a Wayland walk on a headless compositor (`weston --backend=headless`) and the parity rows that differ |
| Widevine: the Mac has no CDM (`chromium-widevine-without-cdm.patch`); Electron on Linux plays L3 through castlabs' licensed build; the engine's component updater is security-only | Decision for the owner: allow Widevine's component (`oimompecagnajdejgnnjijobebaeigek`) on Linux, fetched from Google on the first DRM request as other Chromium-based Linux browsers do (a `chromium-linux-widevine-component.patch` beside `chromium-component-updater-security-only.patch`), or ship without DRM like the Mac. Until then the engine build has no Widevine and the row says so |
| Linux's key storage replacing the Safe Storage key silently when the keyring is late at login (the Mac's `chromium-safe-storage-no-silent-reset.patch` is skipped on Linux) | Check Chrome 157's Linux key providers (`os_crypt_async`'s freedesktop and portal providers) for a path that makes a new key while an old one exists; if one exists, a Linux counterpart patch |
| One Linux tree, several streams building | One lock (`ac-chromium-linux.lockf`, `env.sh` already names it), incremental builds only, each stream's targets named (`//ardia/linux:*` compile alone in minutes); the TypeScript streams need no engine build |
| Blur over pages: CSS `backdrop-filter` in the UI can't see the page's pixels (another surface) | Surfaces stay nearly opaque over pages as on Electron; later, `ui::Layer::SetBackgroundBlur` on a layer under the UI at each blurred cover's rect, from a `blur` flag in `tab.show`'s holes |
| Accessibility order with two `WebContents` in one widget | An AT-SPI dump (`accerciser` or `dbus-send` over `org.a11y.Bus`) in the walk |

## Work breakdown

Six streams. Each owns its files outright; a stream that needs a change in another's files asks its owner. Engine
streams build in the one Linux tree under `ac-chromium-linux.lockf`; TypeScript streams don't build the engine.

**S1, the engine tree, series and packaging** (linux-engine-build, already running). Owns `scripts/linux/engine/**`
except `src/`, the patches and `series-linux`, `linux-hooks`, `ardia-win-on-linux.patch`, `scripts/linux/package-engine.mjs`,
`apps/browser/linux/packaging/**` (moved from Electron's, shared), `.github/workflows/linux-engine.yml`, and the engine
prebuilt release. Next, in this order: `chrome` builds as it is now; `series_linux.py layer` builds
`chrome/browser/ardia` on Linux and copies the shared `//ardia/win` files, the `//ardia/core` portable files and
`scripts/linux/engine/src/ardia/**`; `series_linux.py hooks`; `chromium-linux-app-in-browser-process.patch` and
`chromium-linux-ardia-layer.patch` with an empty `//ardia/linux` that only logs; the widened Windows patches. Later the
context menu, location, reauth, default-handler and Widevine patches as the other streams ask, and packaging.

**S2, the engine host** (C++). Owns `scripts/linux/engine/src/ardia/linux/{main,main_delegate,main_parts,content_browser_client,app_lifetime,test_gate,log,api}.*`,
`host/**` (Host, InputRegion, key routing), `browser_window/**` (the port of the Mac's ACBrowserWindow and its delegate,
modal host, location and find bar stand-ins), `windows/**` (AppWindow, its frame, drag regions, shape, fades,
`ArdiaAppWindows`), the Linux `ardia/win/{host.h,hooks.h,BUILD.gn}` overlays, and `scripts/linux/engine/src/ardia/linux/BUILD.gn`.

**S3, the UI host and bridge, and the UI's engine backend** (C++ and TypeScript). Owns `ui_host/**` (WebUI, data
source, CSP, host `WebContents`, child adoption call into S2's `AppWindows::Adopt`, navigation throttle, mojom,
browser bridge, `ModuleRegistry`), `renderer/**` (the bridge object, the renderer client subclass),
`packages/expo-linux/src/chromium/**`, the `*.chromium.ts(x)` twins, `apps/browser/linux/renderer/vite.chromium.config.ts`,
`apps/browser/linux/tsconfig.chromium.json`, the new `package.json` scripts, `scripts/linux/test-instance`'s
`--engine`, and `scripts/linux/engine-smoke` (the milestone's checks).

**S4, native modules: files, system, shell** (C++, plus the TypeScript moves). Owns `modules/{app,documents,config,keychain,dialogs,menus,keys,focus,shell,notifications,system,desktop_entry,launch_links,telemetry_local,dev}.*`,
the command table's move into the engine bundle (`packages/expo-linux/src/chromium/keys/**`), and the updater's
TypeScript.

**S5, native modules: desktop services and data** (C++, plus reused TypeScript). Owns `modules/{screen_lock,location,owner_check,owner_prompt,focus_return,file_drop,edge_pointer,report,recording}.*`,
`dbus/**`, `import/**`, `sync/**`, `translate/**` and the engine bundle's wiring of `expo-windows/src/{import,sync}` and
the translate worker.

**S6, Chrome's UI for pages, the page channel and the blocker** (C++). Owns `prompts/**` (passwords, permissions,
autofill, extension install, action popups and side panels, context menu, DevTools docking), `page_channel/**`,
`content_blocker.*`, and the PiP checks (Dia's window on Linux).

**Order.**

1. Now, in parallel: S1 lands the layer copy and the empty `//ardia/linux` in a building `chrome`; S2 writes `main`,
   the test gate, `AppWindow` and the BrowserWindow port; S3 writes the WebUI, data source, bridge and the TypeScript
   backend (the TypeScript typechecks and runs against a fake bridge with no engine); S4, S5 and S6 write their modules
   against the module registry's interface, which S3 publishes first as a header (`ui_host/modules.h`), and their code
   compiles once S1's layer copy lands.
2. Milestone M1 needs S1's layer and app patch, S2's main, windows, Host and BrowserWindow, and S3's host, bridge and
   backend. S4 contributes `ArdiaDocuments` and `ArdiaApp` (the rest falls through to defaults).
3. After M1: S4 and S5 fill the modules in the order the walk hits them (documents, menus and keys, dialogs, focus,
   shell, system, then the rest); S6 starts with permissions and passwords (the rows Electron has and the engine would
   otherwise lose), then the context menu, install prompt, page channel and content blocker.
4. The engine walk of `docs/linux.md`'s 64 rows, then the Electron removal.

**The first milestone** proves the architecture end to end. In a test instance on Xvfb under xfwm4, from a fresh data
folder, `scripts/linux/engine-smoke` must see:

1. The engine starts with no window of its own, and the host loads `chrome://ardia-app/index.html` from `ARDIA_UI_DIR`
   (the host target in `/json`, `launch.log` naming the UI folder and the test gate's decision).
2. `window.ardiaLinux.modules()` lists `ArdiaDocuments`, `ArdiaApp`, `ArdiaAppWindows`, `ArdiaEngineHost`, `ArdiaMenus`;
   `callSync('ArdiaApp', ...)` and `call` answer; an engine event reaches `onEvent`.
3. The real UI shows in an app window of ours: the main window opened by `window.open('about:blank', id)`, mounted,
   shown after its first paint, rounded, with the sidebar and toolbar (a composited `snapshotWindow`).
4. A page loads in a tab inside it: a fixture page given as the launch link, loaded by `tab.create`, placed by
   `tab.show` under the UI in the same widget, and its title in the sidebar (navigation events reached the UI).
5. The command bar draws over the page: Ctrl+L (real X keys) opens it; the snapshot shows the bar's pixels inside
   the page's rect, with the page visible around it and through no hole.
6. A click reaches the page: a real X click on the page outside the bar increments the fixture's click count (its
   title says so); a click on the bar where it covers the page does not, and the bar takes it. A wheel over the bar
   scrolls the bar, over the page the page.
7. Typing goes where focus is: text typed after clicking the fixture's field lands in the page; after Ctrl+L, in the
   command bar.
8. The quit handshake: Ctrl+Q writes the session and exits within 3 s.

It also logs, for the risks above: the host's timer and frame rates over a minute, the page's lag behind the UI during
the sidebar's slide, and every sync call's time.
