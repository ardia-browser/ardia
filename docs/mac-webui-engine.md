# Mac WebUI host (`scripts/mac/webui-engine`)

The Chromium side of the Mac WebUI shell: Chrome's own process is the app and serves `apps/desktop`'s `--mode mac`
bundle from `chrome://ardia/`, as on Linux and Windows. It grew out of `spike/mac-webui` (`docs/mac-webui-spike.md` on
that branch). It is a development tool and never runs in a release. Like Windows' `scripts/windows/engine`, it lives outside
`engine/`, so no engine key reads it and the Mac release engine is untouched.

## Never in a release

- `//ardia/mac`'s `BUILD.gn` compiles only `ac_mac_webui_release.mm` when `is_official_build` is true: two functions
  that return `false` and do nothing. The Mac engine is built official (`engine/patches/build/gn_defines.sh`), so the
  shipped framework holds no WebUI code.
- Every line `apply.sh` adds to Chrome's files sits under `#if !defined(OFFICIAL_BUILD)` and compiles out of
  official builds.
- In a development build the shell starts only when asked: `--ardia-shell=webui`, or `ARDIA_SHELL=webui` with no
  `--ardia-shell` switch. The switch wins, and values match exactly. `ac_mac_webui_policy.h` decides this.
  `tests/webui_policy_test.cc` runs it in a release build, a dev build, and with both the dev and official defines.
- A development build needs its own non-official out dir on a dev copy of the tree. `build.sh` refuses
  `is_official_build = true` and the shared `~/chromium-build`.
- Background mode is `--ardia-background` or `ARDIA_BACKGROUND=1`/`true` (Wave 4A's handoff and `open --env` pass the
  variable). The launcher adds `--ardia-background` when the variable is set. In background mode the window stays
  ordered out (never `ShowInactive` or `orderBack:`), and no popover or menu is shown or takes focus. A queued context
  menu looks its view up again and pops up only if the document that asked is still the live one.

## What it does

- **Chrome's own window chrome is hidden.** `g_ardia_mac_hosts_normal_windows` (`window_feature_controller.cc`)
  turns off the tab strip, toolbar and bookmark bar for normal windows, the same way Windows'
  `g_ardia_win_hosts_normal_windows` does. `BrowserFrameViewMac::OnPaint` stops painting the frame colour. The
  window is non-opaque, with a clear background, a full-size content view and a transparent, untitled titlebar
  (`ac_mac_window`).
- **Window drag.** `ArdiaShell.startWindowMove` drags the window on a left press or a left drag (`apps/desktop` calls it after 3 px of movement) and `ArdiaShell.captionDoubleClick` zooms or
  minimizes it as the system's `AppleActionOnDoubleClick` setting says, so `apps/desktop`'s window drag regions work.
- **Traffic lights** sit at Ardia's position: 18 pt inset, centred 20 pt down. They come from Chrome's own
  `_titlebarHeight` and `_minXTitlebarWidgetInset`, overridden per window. `shell.trafficLights {center, hidden}`
  moves or hides them.
- **Glass**
  - `shell.backdropRegions` (Wave 4A: `{regions: [{rect, material: "liquid" | "sidebar" | "underWindow"}]}`) puts glass
    behind the window, under Chrome's content view.
  - `shell.glassRegions` (`apps/desktop/src/glassRegions.ts`) puts glass in a per-page under-glass slot. The slot is a
    pass-through view inside the page's own `WebContentsViewCocoa`, above its render view and below the shell's
    transparent view, so the glass refracts the live page.
  - A glass region over no page falls back behind the window, and the part of a region that no page covers (a menu
    straddling the sidebar and a page) gets behind-window slices for exactly the uncovered rectangles; the slices and the page side are all masked by the whole
    region's rounded outline, so the corner curve is the same on both sides of the seam; `accepted` names a region only once every
    slice mounted, so a half-mounted region keeps its DOM fallback. The host advertises `shell.glassBehindWindow`, so
    `glassRegions.ts` also sends regions over the sidebar, toolbar or empty space instead of dropping them.
  - A region may carry `material` (`regular`, `clear`, `sidebar`, `header`, `menu`, `popover`, `hud`, `window`,
    `underWindow`), `tint` (`#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()` or `rgba()`), `appearance` (`light` or `dark`)
    and `group`. `<GlassEffect>` sends its style, tint, corner radius and appearance; `<VisualEffect>` and
    `<PopoverBubble>` send their vibrancy material, so their opaque fallback fill drops once the native view is
    presented. Regions sharing a `group` (from `<GlassGroup>`) join one `NSGlassEffectContainerView` on macOS 26+
    and mount alone elsewhere.
  - The bootstrap sets `ArdiaGlassEffect.isLiquidGlass` from `NSGlassEffectView`'s presence, so the shared UI picks
    its Liquid Glass look on macOS 26+.
  - After a `shell.glassRegions` call's regions are committed, the host posts `ArdiaGlass` `presented {generation}`
    on a later main-thread turn, which `shellGlass.ts` waits for before dropping its opaque fallback. A reload clears
    the glass and drops any `presented` still pending. `accepted` lists only the glass regions that
    actually mounted on a native surface, after backdrops and glass share the 64-region cap. Backdrops and glass keep
    separate ids, so a glass region may reuse a backdrop's id.
  - Liquid materials use `NSGlassEffectView` on macOS 26+ (corner radius and `style`, as in
    `packages/shell/ios/LiquidGlass.swift`), and `NSVisualEffectView` elsewhere.
  - The math is in `ac_mac_glass_layout.h`: validation, zoom, CSS-style radius scaling, planes, diffing and input
    pass-through.
- **Popovers** follow Wave 3B's contract. `apps/desktop` renders the `chrome://ardia/?popover=<id>` surface
  (`kPopoverRendererShipped`), so `shell.popover.*` is advertised and `popoverHost` opens native panels.
  - `main.tsx` is a small entry that loads `popoverEntry.tsx` (`PopoverRoot.tsx`) instead of `shellEntry.tsx` when
    the bootstrap says `surface: "popover"` and the URL's `?popover=` matches (`popoverSurface.ts`), so a panel never
    loads the browser shell, its store or its shims; a popover URL or bootstrap that doesn't validate (one `?popover=`,
    plain-object props) stops with an error instead of loading the shell; it draws only the requested route on a transparent page.
  - Downloads is the first panel: with `shell.popover.*` advertised, `DownloadsPopover.tsx` opens it through
    `popoverHost` (`nativeDownloads.ts`) under the Downloads button, pushes rows as props, runs the actions the panel
    sends back, and falls back to the DOM panel when the host can't open one. A press on its own button closes it on
    release however long it's held. A finished download shows Deleted only after `ArdiaSystem.fileStatus` confirms
    the file is gone; pending, failed, non-boolean or unsupported lookups count as
    present, and reopening the panel re-reads expired statuses.
  - Calls: `shell.popover.open | update | close` (and `beyondWindow`); the host sends `shell.popoverDismissed` with
    `escape`, `outside`, `blur`, `resize`, `host` or `failed`.
  - Each popover is a borderless, non-activating `NSPanel` child window with a glass background, showing a
    `chrome://ardia/?popover=<id>` page.
  - That page's bridge may only close itself, read its own props (`shell.popover.props`) or send
    `shell.popoverMessage` (at most 64 KiB), which `popoverHost` hands to the popover's `onMessage`.
  - `shell.popover.update` with `content.props` (at most 256 KiB) replaces the props and pushes them to the page as
    `ArdiaPopover` `props`.
  - `rect` is in window CSS pixels and is clamped to the anchor screen's visible frame, or to the window when
    `beyondWindow` was false at open; an update without `beyondWindow` keeps the value from open.
  - With `ARDIA_BACKGROUND=1` a popover is logged and never shown.
  - Placement and lifecycle are in `ac_mac_popover_policy.h`.
- **Menus.** The menu bar has a default App/File/Edit/View/Window/Help menu until `apps/desktop`
  (`nativeMenuBar.ts`) pushes the full Ardia, File, Edit, View, Tabs, Bookmarks, History, Extensions, Window and Help
  menus with `ArdiaShell.setMainMenu`. Every window pushes its own menu, state and bookmarks; the host keeps them by
  window and shows the key window's, switching when another window becomes key; a background window can't rewrite the
  bar while any Ardia window is key, and a key window with no menu yet shows a command-free Ardia, Edit, Window and
  Help bar. Menu commands go to the key window, or to the window that owns a key popover. Settings and Import push their own Ardia, File, Edit, Window and Help bar. Edit, Minimize, Zoom, About and full screen use AppKit roles; other window actions come back
  as `menu.pick`. Menu commands arrive as `ArdiaShell.onCommand` with `source: "menu"`. Only `setMainMenu` installs
  the Services, Window and Help menus.
  - `ArdiaShell.setMenuState` updates enabled, checked and titles in place by state id (`command` or
    `command:arg`); a disabled command disables all its variants.
  - `ArdiaShell.setMenuBookmarks` rebuilds the Bookmarks menu after its fixed items, as `appMenu.ts` builds it.
  - The Ardia menu has Services, Hide Ardia (⌘H), Hide Others (⌥⌘H) and Show All; Quit is ⌘Q and full screen ⌃⌘F
    whatever the desktop shortcuts say.
  - Close Window goes through `ArdiaShell.requestWindowClose` when the host advertises it and AppKit's `performClose:`
    otherwise, in browser and utility windows alike.
  - Each shortcut shows the key that presses it, read from `@platform/shortcutKeys`, so on the Mac `command` is ⌘ and
    defaults like ⌘T, ⌘W, ⌘L and ⌘, show as such; system items (Edit, Minimize, Close Window, Hide) use AppKit's
    standard keys.
  - `ArdiaShell.setShortcutRecording` stops the menu bar's key equivalents while that window records a shortcut.
  - ⌘Q goes to the shell's quit flow only once that renderer's shell has painted; before that Chromium quits directly.
  - The in-window `≡` app menu button is hidden on macOS (`platform/appMenuButton.mac.ts`), where the menu bar holds
    those menus.
`shell.showContextMenu` pops an `NSMenu`;
  with `ARDIA_BACKGROUND=1` it is logged instead. The menu model and its validation are in `ac_mac_menu_model.h`.
- **Share** (`ac_mac_share.mm`, rules in `ac_mac_share_policy.h`), as `packages/shell/ios/SharePicker.swift` does.
  - `ArdiaApp.share` and `ArdiaApp.shareText` open `NSSharingServicePicker` beside their anchor (CSS pixels in the
    shell, scaled by its zoom), or centred under the toolbar without one. They settle when the picker closes.
  - `ArdiaApp.shareServices` lists the system's services (not Mail or the Reading List, as on the Mac app), so
    `share: true` submenus show them and More…, which opens `ArdiaApp.openSharingSettings`.
    `ArdiaApp.shareVia` performs one by title. Copy Link and Email Link stay in `apps/desktop` (`hostShare.ts`).
  - The menu bar's File › Share lists the same services, then Copy Link, Email Link and More… (the `shareServices`
    role, filled each time the submenu opens). The in-window app menu adds them once the host lists them.
  - Each share has its own delegate, source window, file and completion. Picker callbacks are matched by sender,
    and a shell reload or window close closes that window's pickers.
  - Only http(s) links, images this instance issued to the same window, and directories (Share Folder…) are
    shared. An image must be a regular file in this instance's own `<pid>-<nonce>` folder, issued while the page's
    binding and shell generation were the ones that asked, and it counts against the 64-image cap until its file is
    deleted. Each instance locks `.lock` with `flock` inside a hidden staging folder and only then renames it
    into place; a later instance deletes only recognized folders whose lock it can take (holding it until the
    delete finishes), or that have no lock and whose process is gone, never anything else. An image reserves its slot
    before its bytes are copied; a write for a retired window or a released, closed or rebound tab, or before
    the instance folder is claimed, is skipped, and the write's reply alone cleans it up. A removed image stops
    being shareable at once but keeps its slot until the unlink is done: at most five tries (four retries,
    500 ms doubling), then the slot is given back. A share whose service the user already
    chose keeps its file through a window close until the service finishes. The Share… items use command
    ids 54100–54109, outside Chromium's custom ranges. Every picker and service callback is matched by sender. File › Share always ends with More…, which opens System Settings › Sharing directly on any page, and the in-window menu waits up to 250 ms for a fresh service list; a newer click or a detached
    button cancels an older open, and a services request that stalls for 5 s is replaced.
  - Page context menus on bound pages get Share…, Share Link…, Share Image… and the rest, placed as ArdiaCore
    places them, through a dev-only `RenderViewContextMenuObserver` hook in
    `render_view_context_menu_base.cc`. Each menu owns its observer until its destructor runs. A choice goes to the shell as a page `command` event, so `shareFromPage`
    cleans the link before it reaches the picker. A shared image is a temporary file the host deletes when the
    share ends, or when the window's shell reloads or closes.
  - With `ARDIA_BACKGROUND=1` the picker, services and settings are logged to `activation.log` and never shown.
- **Shared folders** (`ac_mac_shared_folders.mm`, rules in `ac_mac_shared_folders_policy.h`) port
  `SharedFolderDirectory.swift` call for call: `ArdiaSharedFolders.read`, `apply`, `resolve`, `discard`, `create`,
  `watch` (FSEvents, one watcher per window, `onChange {paths}`) and `revealFolder`; Add Shared Folder… picks its
  folder through the host's `ArdiaShell.pickFolder`. `location` comes in the bootstrap, worked out off the UI thread. Writes use `openat` with
  `O_NOFOLLOW`, `renameatx_np(RENAME_EXCL)` and `NSFileCoordinator` with `SyncCoordination`'s 20-second deadline,
  as the Mac app does. A shell reload or close drops the window's FSEvents watch, and the stream is torn down on
  its own queue. Finder is never shown in background mode.
- **Quit.** The menu's Quit item (⌘Q) is the `quit` command, so `apps/desktop` asks about quitting and active
  downloads (`ArdiaShell.downloadsInProgress`) first. `ArdiaShell.quit` then asks every live window to flush its
  session through the close protocol and exits once all have acknowledged, or after 10 s. A window that refuses
  cancels the quit, and a window that answers after its quit ended keeps its window open instead of exiting. The
  shell already asked about active downloads, so that quit cancels the ones it reported before it exits and
  Chromium doesn't ask again. It counts downloads the way Chromium does at shutdown, and the list belongs to the window that asked: declining
  the download prompt drops it (declining some other question doesn't), so a later Quit can't cancel those downloads without asking again. A download that started
  while the windows flushed is left for Chromium to ask about,
  and if any tab in any browser window still has a "Leave site?" handler to run, no download is cancelled. A
  second Quit while a window is still flushing for the first gives that window a fresh close. With no live shell, Quit exits at once and Chromium asks about downloads itself.
- **Dialogs.** `ArdiaShell.beginDialog` and `cancelDialog` show `confirm` and `prompt` as an `NSAlert` sheet on the
  window, one at a time, and answer with `shell.dialogResolved`. With `ARDIA_BACKGROUND=1` a dialog is logged and
  answered as cancelled. The request checks are in `ac_mac_dialog_policy.h`.
- **Window close.** `requestWindowClose`, `beginWindowCloseDrain`, `acknowledgeWindowClose` and `rejectWindowClose`
  follow Linux's protocol (`shell.closeRequested`, `shell.closeCancelled`). The red traffic light asks the shell first
  instead of closing at once. A departing window's session is saved before it closes.
- **Window state and controls.** `ArdiaShell.windowState` reads the real window (zoomed, full screen). The host sends
  `windowState` and `onWindowEvent` (`focus`, `blur`, `frame`, `maximized`, `fullScreen`, `close`, `sidebarEdge`)
  as the window changes. The sidebar edge lets go when the pointer leaves for another app's window, and while it is
  over just outside the window it checks the pointer every 100 ms. It also serves `toggleFullScreen`, `restoreFullScreen`, `setWindowTitle`, `minimizeWindow`,
  `toggleMaximizeWindow`, `setWindowFrame`, `setAppearance` and `watchSidebarEdge`, plus `setShortcutRecording`,
  `setSwitcherCapture` and `restoreShortcutFocus` for the shortcut recorder and the tab switcher. Browser windows
  are at least 720 × 460, as in the React Native app. A background instance never goes full screen or minimizes.
  These checks are in `ac_mac_window_policy.h`.
- **Unclaimed tabs.** Tabs Chromium opens on its own (`target=_blank`, `window.open`) are offered as `ArdiaTabs`
  `unclaimed` and through `ArdiaTabs.unclaimedTabs`, and `tab.create` adopts an offered one by `adoptId` (`tab:<id>`).
- **Downloads, Finder and the system** (`ac_mac_system`, rules in `ac_mac_system_policy.h`).
  - `downloads.list | remove | clear` are served by the host, which watches each window profile's download manager and
    sends `ArdiaDownloads` `downloads.changed` (throttled to 100 ms while a download runs) and `downloads.removed`.
    Private profiles are never watched.
  - `ArdiaSystem.openFile`, `moveToTrash` and `revealFile` (Finder) take only paths of listed downloads; `fileStatus`,
    `fileIcon` and `runningAppIcon` answer as `packages/shell/ios` does, icons as PNG data URLs.
  - `isDefaultBrowser`, `setAsDefaultBrowser`, `launchAtLoginStatus`, `setLaunchAtLogin` (`SMAppService`), `hapticTick`
    and `setThinScrollBars` (overlay scrollers) match the native modules; a background instance changes none of them.
  - `ArdiaShell.pickFiles` and `pickFolder` open an `NSOpenPanel` sheet, one per window; a background instance logs the
    request and answers cancelled. `ArdiaApp.openExternalURL` refuses local, script and browser-internal schemes.
  - Links from other apps: the host replaces `AppController`'s `application:openURLs:` when the shell starts, keeps
    http, https and file URLs for the shell and passes the rest on, and sends them as `ArdiaShell` `onOpenURLs` to the key
    window that called `ArdiaShell.listenForOpenURLs`; links from a cold launch wait for the first window.
  - Download watches follow the window's members: the window's own profile always, a companion profile only while it
    has a tab in the window. Links still queued when the last WebUI window closes go back to Chrome.
- **Extension popups and side panels** (`ac_mac_extension_view`, rules in `ac_mac_extension_view_policy.h`).
  `extensionView.create | viewport | place | command | release` host an extension's `ExtensionViewHost` in the window,
  a side panel under the shell like a page and a popup above it, with Linux's placement, reveal and `frame` handshake.
  `extensions.actionStates`, `sidePanelUrl`, `chooseFolder`, `inspectUnpacked` and `resolveInstallPrompt` are served
  by the host, `tab.command executeExtensionAction` runs an action, and the host answers Chrome's install prompt and
  side panel hooks with `ArdiaExtensions` `extensions.installPrompt` and `extensions.sidePanel`.
- **Picture in picture** (`ac_mac_pip`, rules in `ac_mac_pip_policy.h`). `apply.sh` adds `g_ardia_mac_video_overlay` to
  `CreateVideoOverlayWindow`, so the host makes the player: automatic picture in picture plays inside the window that
  shows its tab and the site allows it (Ask goes to Chrome's window and its prompt), on a native plane (an `NSView` with its own compositor, hosted by a `NativeViewHost`) ordered above
  the pages and below the shell (`pip.attach | viewport | command`, `ArdiaPip` `player`), explicit picture in picture and pop-outs use
  Chrome's own window, placed on the display under the pointer and kept, at its 284×160 minimum, inside that
  display's work area. The in-window plane follows backing scale, display and colour changes. `webView.setAutoPictureInPicture` sets `g_ardia_auto_picture_in_picture_off`.

- **Trackpad swipes** (`ac_mac_swipe`, rules in `ac_mac_swipe_policy.h`). A local `NSEvent` scroll-wheel monitor per
  window, scoped to that window and removed with its host, reads AppKit's real `phase`, `momentumPhase` and
  `hasPreciseScrollingDeltas`, so a live two-finger drag, its momentum and a mouse wheel click are told apart without
  timers. Each gesture keeps the surface it began on.
  - Over the shell it sends `ArdiaShell` `onScrollGesture {phase, momentum, dx, dy, x, y, t}` (`mayBegin`, `began`,
    `changed`, `ended`, `cancelled`, `none` for momentum, `wheel` for a mouse click) and swallows nothing. The shell
    advertises `shell.scrollGestures`, and `swipe.ts` then drives the profile pager from these phases alone: it ends
    the drag on the event the fingers lift with, ignores the momentum of a swipe it tracked, and only holds a DOM
    `wheel` off the shell's scrollers while a swipe or its momentum is its own.
  - A gesture that moves to another surface before it starts, or whose window or app resigns, cancels the route it
    left, so a pager held by `mayBegin` settles instead of staying held.
  - Over a hosted page a back or forward swipe is sent as Linux's `onPageSwipe` with the tab's id and a gesture number,
    timed by the same phases. It starts only with the system's swipe-between-pages setting on, after the page's first
    non-momentum touchpad scroll update comes back unconsumed, and then only on horizontal intent. Acks are matched to
    the gesture by the wheel timestamp Chromium carries from the `NSEvent`, converted with `EventTimeStampFromSeconds` and compared
    to the microsecond, so a late ack from an earlier gesture is dropped. Every frame widget of the tab is watched as
    frames come and go, so a wheel aimed at a non-scrolling cross-site iframe still opens the gesture, and a new
    primary page cancels it. A page that
    scrolls, or calls `preventDefault` on the wheel, keeps its gesture (carousels, maps, Figma), and so does a
    vertical start (latched on the first deltas). A consumed update before the shell claims the swipe cancels it.
    The gesture is bound to its tab's binding, generation, document and widget, and is cancelled as
    soon as any of them changes or the tab stops being shown. `swipe.ts` routes it only to the swipe area whose
    `pageTabId` is that tab.
  - The host swallows a page swipe's horizontal motion only after the shell claims it with `shell.pageSwipeClaim
    {gesture, tabId, claimed}`, which `swipe.ts` sends once it tracks the swipe (history in that direction, horizontal
    intent) and withdraws when it lets go. The end always reaches the page. Chrome's own history swiper is turned off
    for the shell and every hosted page (`HistorySwipingControl`).
- **Page commands.** `tab.command` serves the shared `WebViewHandle` set with Linux's names, arguments and replies
  (`ac_mac_page_commands.mm`, checked by `ac_mac_page_policy.h`).
  - The commands: `find`, `stopFinding`, `print`, `runPageCommand` (`savePage`, `systemPrint`, `viewSource`),
    `showDevTools`, `zoomStep`, `goToOffset`, `evaluate`, `edit` (advertised as `tab.edit`), `getSecurityInfo`,
    `discard`, `sleepIfHidden`, `setFrozen`, `downloadFavicon`, `downloadImage`, `openBlockedPopup` and
    `resolveUnresponsive`.
  - `evaluate` runs only the page operations on Linux's allowlist (`ac_linux_page_operations.h`, a dev copy),
    re-encodes their arguments and runs them in an isolated world. The element picker's `apply` and `unhide`
    settle in a promise, so the host waits for their result: it polls with a token it chose, for at most 5 s.
    An evaluation belongs to the binding that asked, and ends when that binding is released or rebound.
  - `sites.setZoom` and `sites.zoomLevels` go straight to the profile's `HostZoomMap`.
- **Page events.** `ac_mac_page_events.mm` sends these `ArdiaWebView` page events in Linux's shapes, and includes
  them in the `tab.create` snapshot: `favicon`, `media`, `fullscreen`, `status`, `crashed`, `loadError`, `security`,
  `zoom`, `popupBlocked`, `unresponsive`/`responsive`, `find`, `discarded` and the real `themeColor`.
  - The hover URL, hangs, context menus, JavaScript and leave-page dialogs, file choosers and permission prompts go
    through a `BrowserWebContentsDelegate` subclass (`ac_mac_page_delegate.mm`, installed through ArdiaCore's
    `g_ardia_create_web_contents_delegate`), so `apply.sh` adds no Chrome hook for them.
  - With `ARDIA_BACKGROUND=1` each of those is logged by kind and answered without UI. A permission request
    gets a prompt with no UI that dismisses itself. The hooks are set again after ArdiaCore's startup task and on
    each `tab.create`.
  - A tab whose contents Chromium replaces keeps its binding through a `pageLifecycle` rebind. A tab that leaves
    the window's tab strips loses its binding.
- **Peek, split and link options** (`ac_mac_link_gesture.mm`, rules in `ac_mac_link_policy.h`, a port of Linux's
  `ac_linux_link_gesture`). The host advertises and serves `webView.setPeekModifier`, `setSplitLinkModifier`,
  `setPeekOtherSiteTabs`, `setLittleArdiaOpensNewTabLinks`, `setPopupsOpenAsTabs` and `setCommandScrollZoom`, so
  Settings › Tabs shows its Peek and Little Ardia rows and Advanced shows ⌘-scroll zoom.
  - The Mac shell runs no page script, so link clicks are read from Chromium's own dispositions: a renderer
    `kNewWindow` (⇧-click, ⌥⇧-click) and `kNewSplitView` (⌥⌘-click) in the page delegate's `OpenURLFromTab`, and
    ⌥-click's download in `RenderFrameHostImpl::DownloadURL`, which `apply.sh` hooks; the host registers through
    `content::SetArdiaMacDownloadUrlHook`, exported with `CONTENT_EXPORT` so component builds link.
    Each must match the last left mouse-up that page's `RenderWidgetHost` saw, with Linux's gate (on that page, unused,
    no press since, at most 10 s old, exactly the configured keys), carry a user gesture, and go to the link the
    pointer was over at that release (`UpdateTargetURL`). It is then sent as `ArdiaWebView` `openWindow` with `peek`
    (and the click's `point`), `split`, `window` or `background`, as Linux does.
  - The ⌥-click download hook sees the requesting frame, so it only takes a request from that tab with no suggested
    file name that follows redirects, within 1 s of the release. Blink drops `<a download>`'s attribute on a ⌥-click,
    so `apply.sh` also adds a dev-only hook to `HTMLAnchorElementBase::HandleClick` that keeps the attribute as the
    suggested name; an ⌥-clicked `<a download>` then always downloads. `Content-Disposition: attachment` responses are navigations and never
    reach it.
  - A renderer `kNewWindow` that matches no gesture opens as a foreground tab through Chromium's own path, so its popup
    blocker still decides.
  - Links to other sites: `apply.sh` adds `g_ardia_mac_add_navigation_throttles` to
    `CreateAndAddChromeThrottlesForNavigation`, and the host adds a throttle to primary main-frame navigations in the
    shell's tabs while `setPeekOtherSiteTabs` lists any. In a listed tab, a plain cross-site anchor click is cancelled
    in `WillStartRequest`, before any request goes out, when it is `WasInitiatedByLinkClick`, started by the primary
    main frame (an iframe's `_top` anchor follows), carries a user gesture, isn't a POST, goes to the URL released
    over, and its `NavigationInputStart` is that release's own timestamp (a script's `anchor.click()` carries the time
    it was made). The peek is sent once that navigation finishes uncommitted, and not at all if the tab is being
    destroyed (frame teardown finishes the navigation before `WebContentsDestroyed`).
    A script's `location.href` from a click handler is not a link click and follows.
  - Popups open as foreground tabs when `setPopupsOpenAsTabs` is on, except in Little Ardia. In Little Ardia
    (`kind: "small"`), with `setLittleArdiaOpensNewTabLinks` on, a plain click on a link that would open a new tab
    opens in place (`openWindow` `current`) when it has no opener and isn't a form submission. Chromium routes it
    through `OpenURLFromTab` or, for `target="_blank"` and `rel="noopener"`, through `CreateNewWindow`. There
    `apply.sh`'s hook (`content::SetArdiaMacNewWindowInPlaceHook`) runs first for opener-suppressed requests, before
    any child `WebContents` is created or announced to observers, and still sees `is_form_submission` and the POST
    body.
    `window.open` with an opener and POST forms keep their own contents.
  - ⌘ with a mouse wheel over a shown page zooms it one step per 30 points of scroll, routed by the native hit test at
    the event's own location; the count restarts when the page changes or the setting is turned off, and precise
    (trackpad, Magic Mouse) scrolling never zooms.
- **UI bundle.** The host loads it from `ARDIA_WEBUI_BUNDLE`, else `--ardia-ui-dir`, else the app's
  `Resources/ardia-ui`. `assemble.sh` builds `Ardia WebUI Dev.app` (`com.ardia.browser.webui-dev`).

## Engine key and checks

- No engine key reads `scripts/mac/webui-engine`, and `engine/patches/series`, `engine/ardiacore/apply.sh` and
  `scripts/agent/engine-build` are unchanged, so the Mac and Linux keys stay as they were.
- `build.sh` applies the layer to its own dev tree after `engine/chromium` and `engine/ardiacore`, with `--dev`: Linux's
  `bootstrap.js`, `generate_bootstrap.py` and the desktop route table come in from `dev-copies.tsv`.
- `apps/browser/src/boundaries.json` has a `mac-webui-*` row for each bridge handler and for the launch environment;
  each cites the guard and its `hostile_sinks` test.
- The shared hostile corpus (`scripts/security/hostile-inputs.mjs`) is exported byte-exact by
  `tests/hostile-corpus.mjs` and run through every guard by `tests/hostile_corpus_test.cc`.
- Documents never use the name `session.json` in any ASCII case, and a session over 64 MiB is refused before it is
  written (`ac_mac_shell_policy.h`).
- `tests/mac-layer.test.mjs` runs `tests/test_mac_layer.py` in `node --run test:root` (Linux CI), and the Mac
  workflow's `webui-engine` job runs it with Clang on macOS.

## Commands

```sh
python3 scripts/mac/webui-engine/tests/test_mac_layer.py
CHROMIUM_SRC=<dev tree> scripts/mac/webui-engine/build.sh out/WebUIDev_arm64
scripts/mac/webui-engine/assemble.sh "<dev tree>/out/WebUIDev_arm64/Chromium Framework.framework" apps/desktop/dist/mac /tmp/webui/"Ardia WebUI Dev.app"
ARDIA_WEBUI_BUNDLE=$PWD/apps/desktop/dist/mac scripts/mac/webui-engine/launch.sh /tmp/webui/"Ardia WebUI Dev.app" /tmp/webui-data 9333
```
