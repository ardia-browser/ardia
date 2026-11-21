# Ardia on Windows

Windows comes before Linux, and both share one codebase with the Mac: no fork. The Windows work lives on its
branch (PR #1116) until the owner merges it. This file is
the plan and the state of the port. The request is issue #351.

## What is shared

| Layer | Shared | Language |
| --- | --- | --- |
| UI and app logic (`apps/browser/src`, `packages/core`) | Yes | TypeScript |
| Browser logic (ArdiaCore's shared core, `engine/chromium`) | Yes | C++ |
| Chromium and the patches that apply on every OS | Yes | C++ |
| The `ac_*` C API between the UI and the core | Yes | C |
| OS calls: windows, menus, secrets, glass, shaders | No, one per OS | Mac: Swift and Objective-C. Windows: C++ |
| The Mac-specific engine patches | No, each gets a Windows version | C++ |

Logic is written once. Only code that calls the OS is written per platform.

## What works on Windows today

Walked by hand on 2026-11-14 in the Windows 11 ARM VM (1920 by 1080), with the `Ardia-Setup-arm64` installer of run
43544610044 (commit 45a0962e6, engine `windows-engine-20261113-12`, `ArdiaApp.dll` checked against the artifact), from
a fresh data folder, as a user would: 41 driven runs, every row below seen on that build. Later that day the rows
changed by #1658, #1686 and #1691 were seen again, and Tour and Open at login walked, on run 43565273476 (commit
d83398e1f, engine `windows-engine-20261113-16`), and the intro, onboarding and tab strip that evening on #1737's
build 72901e27a (run 43624897005, engine `windows-engine-20261113-21`); those rows say so, and rows others saw say
who and on which build. Of the 76 rows, 56 work, 8 work with a difference, 4 do nothing, 7 are not offered
and 1 was not walked. Works with a difference says
what differs; the Mac's list is `docs/dia-feature-parity.md`. Rows marked "hidden" are off on Windows behind
`PLATFORM_FEATURES` until what they need exists. The walk before this one (2026-11-13, bfd586fe) is in git history.

**Install, first launch, updates**

| Feature | State | Tracked in |
| --- | --- | --- |
| Installer (wizard, Start menu, Open Ardia) | Works (`setup exit 0` over an empty and over an existing install) | |
| First launch after the installer | Works: onboarding, no release notes | #1517 |
| First launch with a link | Works: the link opens in a Little Ardia window in front, onboarding waits in the main window behind it | |
| Onboarding (main's walk-through, #1762) | Works (72901e27a): eight steps (source, layout, tabs, look, search and privacy, pins, default browser, outro), Edge found on this PC, Windows wording, Ctrl+T, Ctrl+L and Ctrl+S key caps, no Dock card or trial, no app icon row; Skip on every step; Get Started and Take the Tour. Gaps: Tab leaves the intro for the page behind it, and the links step names the Mac's Notes (#1812); the default-browser hand-off to Windows Settings wasn't seen (the VM's default is already Ardia) | #1812 |
| Intro animation and music | Differs: no Windows machine with a real GPU has run the animated meadow yet. Where Chromium gives no WebGL2 (the VM and the CI runners: no GPU, and the engine has no SwiftShader) the dawn poster stands in, or the plain dark background at night, within about 0.4 s (14 of 14 launches on 72901e27a). On software rendering (WARP, turned on with test switches) the scene draws: in the VM on 65dd9760b, in light with the page's own icon and wordmark and at night with the moon and fireflies; Tab, Space and Enter work Mute and Skip, and a click on Skip ends it. The WARP self-check runs it on every PR on x64 and ARM64. Music not checked (the VM has no audio out) | #1547, #1546, #1737, #1249 |
| Tour | Works (d83398e1f): Take the Tour shows five stops (search, tabs in the sidebar, room to focus, two pages side by side, all set) with Back, Next and Skip Tour; Done ends it | |
| Import from Edge | Works (onboarding finds Edge; import itself checked in #1357) | #1516 |
| Check for updates | Differs: Check Now says "No Windows update published yet" and names the build (0.2.47-nightly.1, Windows alpha 290) | #1517 |
| Default browser | Works: Settings › General says "Ardia is your default browser" in this VM | #1439 |
| Open at login | Works (d83398e1f, the VM user's own data folder): on, it writes the `Run` entry for the installed `Ardia.exe`; off, it removes it. When Windows has it turned off in Task Manager's Startup apps, the row asks you to allow it there (#1694; it named the Mac's System Settings before). A sign-in wasn't done: it needs the VM account's password | #1694 |

**Windows and tabs**

| Feature | State | Tracked in |
| --- | --- | --- |
| New tab, close, reopen closed tab (Ctrl+Shift+T) | Works | |
| Ctrl+Z reopens closed tabs | Works once turned on in Keyboard Shortcuts (off by default, as on the Mac) | |
| New window | Works | |
| Private window | Works; closing one with two tabs asks first (Close 2 tabs?, Don't ask me again) | #1453 |
| Close-tabs confirm while other windows load | Works: the confirm (like the prompt and the file pickers) runs on its own thread, so other windows keep loading and taking input while it is open; it stays in front of its own window and comes forward with it (#1688's self-check holds a confirm while a page loads, on CI; not walked here) | #1672, #1688 |
| Quit and relaunch with the session restored | Works (tabs, the split and the open windows came back) | |
| Engine memory trimmed after tabs close, once input is idle | Works (logged after closes) | #1544 |
| Memory Saver's loaded-tab budget (the tabs hidden longest sleep past it) | Works (engine `windows-engine-20261116-4`, which also has #2052's page-place guard; seen by the `engine sleep:` self-checks in CI, not walked in the VM): the Mac's budget and sweep, sized from this PC's memory and Windows' memory load (85 % a warning, 95 % critical); the page view's `sleepIfHidden` asks Chromium's discard policy with the proactive reason, so a shown page or split pane, a page hidden within the mode's wait, typed form input, audio, capture and the other protections keep a tab awake. A page the app hid is no longer its page window's active tab, which Chromium would otherwise keep from every discard, and Chromium's DevTools-open state means a DevTools window inspects the page, not the engine's own always-attached page client (before -10 no Windows page could be discarded at all, by this budget, Chrome's Memory Saver timer or memory pressure). A discard is in place (`WebContentsDiscard`, as on the Mac), so the tab keeps its page and back/forward list. A slept tab wakes on show at its address and scroll. A pop-up window's page is not a tab, so the budget never asks it. The engine keeps a page for its own reasons too, in every discard but one the user or one of their extensions asks for (Chrome's Memory Saver timer, its memory-pressure and frozen-with-growing-memory discards as well as the budget, `kept_pages.cc` through `chromium-win-discard-asks-the-host.patch`; a kept page is never taken by an urgent discard either, since Windows' urgent discards skip protected pages; a discard the user or one of their extensions asks for, such as `chrome.tabs.discard()` from a tab-suspender extension, does not ask the host): the opener of a live pop-up or of a pending offer (100), so the pop-up's `window.opener` keeps working; a `beforeunload` handler (content's own handler state; the page graph's flag is never set in Chromium 157) on a page the user has used (101); a held Web Lock (102) or blocking IndexedDB lock (103); a WebSocket, WebTransport, WebRTC or direct-socket connection (104: the same signals that keep a page from freezing; in Chromium 157 an open WebSocket registers only the sticky feature, so a page that has used one stays kept until it navigates or reloads); a DevTools window, or a DevTools client other than the engine's own on the page or tab target: an extension's `chrome.debugger` or a remote CDP tool (105). Chromium's own protections hold as on the Mac (audible, capture, form input, notifications). Not seen yet, so such a page can still sleep (#2050): a Web Lock held by a dedicated worker, a WebSocket held by a SharedWorker, a blocking IndexedDB lock in a shared or service worker, an EventSource or long fetch stream, an upload. A hidden Peek card that stays mounted is not a shown page: after the mode's wait it can sleep, and it reloads at its address and scroll when it shows again. A tab that slept once still opens a new tab its link script saw clicked (the script Peek runs in) and an app-link ask. Pinned tabs sleep like any tab, as on the Mac (#1069). A page window keeps #2052's guard through a sleep and holds its place again once it wakes. Self-checks: `engine sleep:` in `selfCheck/engineSleep.ts`, `engineSleepKept.ts` and `engineSleepPlace.ts` | #1969 |
| Unload inactive profiles (Settings › Advanced, with Memory Saver) | Not offered; hidden: the engine has no `profiles.unloadIdle` | #1425 |
| The `ardia` command (the install 8 s after launch, Settings › Advanced › Command line) | Not offered: Windows has no native `ArdiaCli`. `PLATFORM_FEATURES.ardiaCommand` is false, so Command line is hidden in Settings and nothing is installed at launch. Its stand-in (`defaults.ts`) answers `canInstallUnattended` false and `install` with a failed result, and `installCliInBackground` treats a missing result as a failure. (Before, both answered null: the launch install threw `Cannot read property 'ok' of null`, an unhandled rejection 8 s after launch for nearly every Windows user, and Command line stayed on "Installing…".) Tests: `cliControlWindows.test.mjs`, `hiddenOnWindows.test.mjs` | #2135 |
| Little Ardia (Ctrl+Alt+N) | Works, app-drawn chrome; its command bar lists recent pages | |
| Search Tabs (Ctrl+Shift+A), Ctrl+Tab | Works (d83398e1f): the new page has the keyboard after Ctrl+Tab and after Next Tab into a tab a restore left unloaded (#1658, #1691). Gap: a new tab opened with an address (Ctrl+T, the address, Enter) doesn't get the keyboard, tracked in #1689 (still so on 72901e27a) | #1658, #1689 |
| Pin, Top Apps, New Group with Tab, tab menus | Works (the tab menu offers Move to Top Apps, Remove from Split View, Close Split View) | |
| Page picture (a pinned page in another window) | Works: the other window shows the page picture | #1540 |
| Tabs in the sidebar or across the top (Ctrl+Shift+S), hide the sidebar (Ctrl+S) | Works. The pale box once left over the page's top-left came from visiting a second profile, not from Ctrl+S: the next profile's sidebar page, parked beside the sidebar, cut a hole in the page. Gone on d83398e1f, on a full-width tab and a split pane. With tabs across the top (72901e27a), the open and recently closed tabs button and New Tab stay clear of the caption buttons down to the narrowest window (600 px), where tabs scroll instead, and a right-click on the empty strip opens the tab menu | #1673, #1583 |
| Minimalism mode (Ctrl+Alt+M) | Works, except one edge (53d5a2bee, walked 2026-11-14): in all five layouts (sidebar left, right, hidden; tabs on top with the strip shown and hidden) the window buttons sit in the band, the sidebar header or the strip with only app UI under them; minimize, maximize, restore and close work, the band, strip or header drags and double-click maximizes; Split View, full screen, a second window and turning it off behave, at 100% and 125%. Left, right and bottom resize work; where the page reaches the top edge (sidebar right), the band resizes the window (#1888; a real drag in CI, the cursor and double click untried in the VM) | #1831, #1888 |
| Profiles: switch with Alt+1, Alt+2 | Works (Work opened in its own colour) | |
| Open in WebKit, Engines pane, Opens in | Does nothing (no WebKit on Windows); hidden | #1522 |
| Split View (Ctrl+\, two pages, Next Pane) | Works: the empty pane takes the next address, Alt+Shift+] moves focus to the other pane's page. Seen on #1686's build: Focus Next Split Pane into an empty pane puts the typing in its search field, and a page left full screen by a tab switch comes back in a window and gets Escape | #1490, #1658 |
| Peek | Works: Shift-click opens it over a split pane and in a private window; Escape closes it. Keys reach the Peek's page without a click, and after Escape they reach the source page with the link still focused, as on the Mac (the engine thread saw both in the VM on build 339 of #1708; not re-walked here). Its buttons at the top, left and right (53d5a2bee, walked 2026-11-14) are app UI over the page with a clean cut, answer clicks, include Split View's, and the tooltip reads "Open as Tab (Ctrl+O)" | #1531, #1576, #1708 |
| A download while split | Differs: an insecure (http) download is blocked by Chromium's own download bubble; a download from localhost reaches Ardia's panel | #1519 |
| Pop-up windows from pages | Works: the pop-up stays a tab of its opener's window, so `window.opener` and `postMessage` keep working, and shows in a pop-up window the app draws, sized and placed as the page asked | #1518 |
| Open pop-up windows as tabs (Settings › Tabs › Links) | Works, not seen on Windows yet: with it on, a page's pop-up opens as a foreground tab beside the page instead of a pop-up window, as on the Mac (`engine/popupsAsTabs.ts`); a pop-up from Little Ardia, one with no page to open beside, an extension's, and a pop-up window already open stay windows | #1986 |
| Main, Settings and Little Ardia window chrome | Works, no system title bar | |

**Pages**

| Feature | State | Tracked in |
| --- | --- | --- |
| Command bar (history, open tabs, suggestions) | Works | |
| Inline completion in the command bar | Works (top match completes inline) | #1520 |
| Find in page | Works: the app's find bar, from a page or the app's UI (Ctrl+F); count, Enter, Shift+Enter, F3 and Shift+F3 step; Escape gives the page the keyboard back; private windows too | #1758 |
| Page loading in the address field | Works (#1865's build 0bcabc63e, run 43642845254, 125%): while a slow page loads the glow fills the toolbar field, a Split View pane's field, a Peek's bar and Little Ardia's field, sweeps across when the load ends and fades; a load under 150 ms shows nothing; the tab's spinner and the stop button as before | #1820 |
| Reading mode (Ctrl+Alt+R, F9) | Works (53d5a2bee, walked 2026-11-14): it draws on a local article and on Wikipedia; Larger Text and the font switch work, Escape leaves it, F9 and Ctrl+Alt+R toggle it and it stays across a tab switch. A reload leaves it, as on the Mac. Find in page finds nothing inside it, as the shared reader keeps the article in a closed shadow root | #1831, #1883 |
| Zoom (Ctrl+=, Ctrl+0) | Works, with the zoom icon in the address bar | |
| Print | Works (Chromium's print preview, Microsoft Print to PDF) | |
| JavaScript alert, confirm and prompt | Works (Chromium's dialogs over the page) | |
| Page, link and image menus | Differs: Chromium's menu, trimmed as on the Mac (no Open link in split view, Cast, reading mode, QR code, send to your devices, Lens or other-profile items; Save as shows no Ctrl+S), but without the Mac's own items for a selection (search with Ardia's engine, Share) | #1811 |
| Full-screen (a page element) | Works; Escape leaves it | |
| Picture in picture | Differs: Chromium's window, no stash, corners or mini player | #1425 |
| Downloads (download, panel, Ctrl+J) | Works: the panel opens for a new download and lists it, including one held for Keep; Ctrl+J opens it and Escape closes it (53d5a2bee, walked 2026-11-14) | #1519, #1610 |
| History (Ctrl+H), Clear Browsing Data (Ctrl+Shift+Del) | Works; history is kept past 90 days and an import keeps its older pages, as on the Mac (engine `windows-engine-20261116-4` passes `keep-old-history`; seen by the `engine history:` self-check in CI) | #2009 |
| Bookmarks (Ctrl+D, Ctrl+Shift+O) | Works | |
| mailto and other app links | Works: the app's prompt, then the handler (`mailto` opens the mail app without a prompt, as Chromium and the Mac allow it by default). The engine thread saw the prompt and the handler in the VM on build 347 of #1701; not walked here. The first click on the prompt works after using the page since #1749, and a data: page's prompt stops counting once its document is gone since #1750 (engine `-22`); the engine thread saw the first in the VM and the self-check proves the second on both CPUs. | #1590, #1701, #1749, #1750 |
| Translate | Not offered | #1520 |
| Network error page | Works (Chromium's) | |
| DevTools (F12), Task Manager (Shift+Esc) | Works (Chromium's) | |

**Passwords, permissions, extensions**

| Feature | State | Tracked in |
| --- | --- | --- |
| Offer to save a password | Differs: Chromium's bubble (Save, Never, No thanks) | #1425 |
| Fill a saved password | Works | |
| Notification and location prompts | Differs: Chromium's prompts (Allow, Block; while visiting, this time, never) | #1425 |
| Camera and microphone | Not walked: the VM has no camera | |
| Chrome Web Store install | Differs: the store says Add to Ardia, Chromium's Add extension dialog, then the icon in the toolbar and the extension's own page | stand-ins `extensions.resolveInstallPrompt` |
| ardia://extensions | Works | |
| Ad, tracker and cookie-banner blocking | Not offered; hidden | #1425 |
| Hide anything (Hide Element) | Not offered; hidden: its rules are kept by the content blocker, which Windows lacks | #1425 |
| Block autoplay on every site, and Autoplay per site in Site Controls | Works (engine `windows-engine-20261116-9`; seen by the `engine autoplay:` self-checks in CI, not walked in the VM): the Mac's settings and rule, enforced in Blink. A tab whose top-level site is set to Block, or has no Autoplay setting of its own while Block autoplay everywhere is on, plays media only in a document whose user asked: a click, tap or key press that reached that document (not Escape, not a Ctrl or Windows-key chord; Ctrl with Alt is AltGr and counts), Ardia's own play controls for the media they play, or a user action through Chrome's media session; a subframe also plays while it has transient activation, as the Mac's page script allows. The site is the top-level document's origin, or for a `blob:` or `about:blank` page the origin that made it. `chromium-win-autoplay-policy.patch` carries the decision to each new document with its commit (out-of-process iframes included), updates open documents when the setting changes, after a back/forward cache restore and when a prerendered page is shown, and refuses in `AutoplayPolicy` before Chrome's exemptions (media engagement, a Sound allowance, capture) and before muted autoplay: `play()` rejects with NotAllowedError, the autoplay attribute and internal resumptions do nothing, detached elements and shadow roots included. Blocking an open page pauses what its user did not ask to play. Plays refused are counted in the engine (`usage_counts.autoplay_plays_blocked`, at most 20 per page). Not covered, as on the Mac: Web Audio. Ardia's play controls reach media in the page and its same-origin iframes only, as before. Self-checks: `engine autoplay:` in `selfCheck/engineAutoplay.ts` | #1425, #1774, #2125 |
| Block requests to send notifications (Settings › Privacy & Security) | Not offered; hidden: it turns a notification request down when the app hears one, and on Windows the app hears none and can't answer one (`permissions.resolve`), so Chromium's own prompt still asks | #1425 |
| Bookmark export | Works: Windows' Save As, then the HTML file is written | #1551 |
| Password export | Works up to Windows' own sign-in prompt over the app window; the walk cancelled it there (the VM account's password is not typed in a test), so the file was not written | #1551 |

**Settings**

| Feature | State | Tracked in |
| --- | --- | --- |
| Settings window, panes, search | Works (all twelve panes; search finds rows and opens their pane) | |
| Profiles: create, switcher | Works | |
| Appearance: light and dark | Works | |
| Higher contrast text | Works (403b48b2c, walked 2026-11-14): Automatic follows a Windows contrast theme turned on while the app runs and one already on at launch, through the shell's `isHighContrast` and its `highContrast` event (react-native-windows' `AppTheme` is UWP-only and always read off). Changing the theme while Settings is open can crash the window layer, on older builds too | #1831, #1882, #1900 |
| Keyboard Shortcuts pane | Works, Windows keys | |
| "…" menu | Works, except Check for Updates | #1517 |
| Sync | Works: Turn On Sync at the default folder shows the Recovery Kit, the pane says updated just now, every What Syncs row but Passwords; a Mac and a PC exchanged pinned tabs and bookmarks both ways (#1594) | #1575, #1425 |
| Calendar | Does nothing; hidden | #1521 |
| Trackpad gestures, video upscaling, reorder haptics, thin scroll bars | Does nothing; hidden | #1522, #1520 |
| Keep new-tab links inside a Little Ardia window, zoom with Ctrl and the mouse wheel, offer to save and fill passwords | Does nothing (the engine has no call for them yet); hidden | #1783, #1425 |
| Warn before quitting | Works (#1796's build 1f4d97db1, run 43631924720): with it on, closing the last window (close button, Alt+F4, Ctrl+Shift+W, a lone Little Ardia's Ctrl+W; Ctrl+W on a window's last tab follows the same rule) asks first with the Mac's words; Cancel keeps the app running, Quit exits, Don't ask again turns it off; a hidden instance never asks | #1782, #1803 |
| Widevine | Not offered (says so) | |
| Copy naming the Mac | Works: the walk found three more (a ⌘T, "History › Recently Closed", "File › Close All Tabs"), fixed in #1668's PR | #1522, #1668 |

## The Windows app

- `apps/browser/windows` is the app project: React Native for Windows 0.81 on the new architecture, which is the
  only one Windows supports from 0.82 on. The Mac stays on the old architecture until it upgrades past 0.81.
- The UI is the same TypeScript. Metro bundles it for the `windows` platform (`pnpm -C apps/browser bundle:windows`),
  where `react-native` is `react-native-windows` and `expo-modules-core` is `packages/expo-windows`.
- `packages/expo-windows` is the API our native packages call (`requireNativeModule`, `requireNativeViewManager`,
  `uuid`), on Windows:
  - a module that has a C++ version answers from it (a React Native turbo module of the same name), one method at
    a time: a method it lacks falls through;
  - a method with no C++ version answers from `src/defaults.ts`, or with `null`, and logs its name once;
  - a view is either native (`ArdiaVectorIcon`, registered in `Modules.h`), drawn in TypeScript
    (`src/views`, `src/symbol`, `src/windowDragRegion.tsx`), or a plain view that logs its name once and lets
    presses through to what is under or inside it (several Mac views are empty layers over other content, and a
    stand-in that took presses made the sidebar's tabs unclickable).

  The log, and `ardiaWindowsMissing()` in the JS console, list what the app has reached so far that has no Windows
  version, not everything left to port.
- The app is a library, `ArdiaApp.dll` (the `Ardia` project), because Chromium's sandbox needs Chromium's own launcher
  to be the process. It runs in two modes, chosen by who calls it (`EngineApi.h` has the types):
  - Standalone: `Ardia.exe` is a stub (`ArdiaLauncher`) that loads `ArdiaApp.dll` from its own folder and calls
    `ArdiaAppRun`, which sets the app up and runs its own event loop. This is what CI builds and tests.
  - In the engine: Chromium's launcher loads the library on its UI thread and calls `ArdiaAppStart` with its API table.
    The app sets up and returns; Chromium runs the loop, hands each message to `ArdiaAppPreTranslateMessage` first, and
    calls `ArdiaAppStop` when the loop ends. Quitting asks the engine (`app.quit`) instead of ending the loop.
    Pending telemetry and documents are written while stopping (`ShutDown` in `Ardia.cpp`), while their worker
    threads still run. Nothing in the library may wait on another thread from an exit handler or a static destructor:
    those run during `ExitProcess`, after Windows has ended every other thread, so such a wait only ends on its
    timeout and the process outlives the quit (#1706: 30 s, which made the installer give up with exit 5). The
    engine now ends the browser process as soon as Chromium's shutdown returns (`AfterChromeMain`, as Chrome does for
    its utility processes), so no exit handler or static destructor runs in it at all.
  - `ArdiaEngineHost` (`EngineHostModule.h`) is the bridge: `available()`, `hostCall`, `engineCall`, and the engine's
    events as `ArdiaEngineHost:event`. Other native code reaches the engine through `Host::Engine()`.
  - What belongs to the app comes from the library (`AppImage.h`: the bundle folder, dialogs, window classes, the
    version); what is about the process stays with the executable (launch at login).
  - Windows finds the Windows App SDK's classes through the manifest of the process's executable, not the library's.
    The `Ardia` project writes that list to `ArdiaApp.winrt.manifest` in the output folder, and the stub links it in
    with its own entries (`ArdiaLauncher/Ardia.exe.manifest`: Windows 10 and 11, per-monitor DPI, common controls 6).
    `scripts/windows/host-manifest.ps1 -From ArdiaApp.dll -To <exe>` writes the same list into another executable,
    keeping what it already declares: the engine's launcher needs it. The library, its DLLs and `Ardia.pri` have to sit
    next to that executable.
- Native code is C++ in `apps/browser/windows/Ardia`, header-only, one module per header, named as on the Mac
  (`ArdiaApp` in `AppModule.h`), all included from `Modules.h`. Events reach JS as the device event
  `<Module>:<event>` (`Events.h`). Folders come from `Paths.h`: data in `%LOCALAPPDATA%\Ardia` or `ARDIA_DATA_DIR`,
  config in `%APPDATA%\Ardia`.
- Windows are the app's own (`WindowManager.h`, `ArdiaAppWindows`): one runtime, one window per window id, each
  mounted with its id, as on the Mac. No window has a system title bar or system caption buttons: every window draws
  into its whole frame, and the UI draws minimize, maximize and close itself (`components/window/WindowControls.tsx`),
  as the Mac's lights live inside the UI there. So no band is kept free at the top: the page card starts at the page
  frame, and Settings and Import have no title bar above them.
  - A browser window comes back where it was left, maximized if it was maximized. Its `frame` event carries the
    window's real bounds and, while it is maximized, minimized or full screen, the bounds it restores to as
    `restored`; the store keeps those as `restoredFrame` and the `maximized` flag, saves both with the session and
    with a closed window, and opens the window at `restoredFrame` with `maximized` (`state/windows/windowPlacement.ts`).
    A browser window opened without a frame copies the size of the browser window in front, 28 points down and
    right, maximized if that one is; with none open, it takes the last browser window's placement, which the shell
    keeps in `window-placement.txt` in the data folder (`WindowPlacement.h`), as the Mac keeps `ArdiaLastWindowFrame`.
    So closing the last window, which quits, and opening the app again keeps the window's size and place even when
    the closed window had nothing to reopen. A window that opens maximized shows maximized at once; one that opens
    behind another takes the foreground for that moment and hands it straight back to the window that had it, as
    Chrome's session restore does, and a background test instance opens it restored. A maximized window moved to
    another display (Win+Shift+Arrow) takes its restored bounds along, at the same place in that display's work area. The launch log says
    `placed <id> like the window in front`, `placed <id> where the last browser window was` and
    `opened <id> maximized`; `launch-smoke.ps1` maximizes a window, quits, relaunches twice and checks both.
  - Where the buttons sit comes from `windowControlsPlace` in `state/windows/layout.ts`: in the card's toolbar row, in
    a right sidebar's header, at the end of the top tab strip, in Little Ardia's bar. With the address bar in a left
    sidebar they sit at the sidebar's leading end, in their own row above the header (one button and a 3 point gap
    tall, `sidebarControlsRow`), in the same order as everywhere else (menu, minimize, maximize, close), and the card
    reaches the page frame (#1973); the row beside them is a caption region, counted from the left (a negative third
    value in a caption region is a width). Only a card with no toolbar and no sidebar showing (address bar in the
    sidebar, tabs hidden) and Minimalism's band layouts keep a 32 point band for them. They take the site's toolbar
    colours in the toolbar, and when the toolbar hides while scrolling a smaller set fades in on the 20 point strip.
    The room every row keeps for them (171 points: 12 to the edge, 129 of buttons, 30 to drag by) is in
    `lib/platformChrome.windows.ts` and `WINDOW_CONTROLS` in `lib/windowChrome.ts`.
  - With no lights on the left, a sidebar header with nothing in it collapses to the page frame on Windows
    (`sidebarHeaderCollapsed`), so the tabs start at the top; the downloads button then sits in the sidebar's footer.
    The header stays for a profile indicator, an incognito window, the address row, and a right sidebar.
  - Resizing from the top edge over a page: Windows keeps the top resize band inside the client area, and the page is
    its own window above it. The page window's hit test (`HostedFrameView::NonClientHitTest` in `ardia/win/frame_view.cc`)
    answers what the app window answers at that point when that is its top edge or a top corner (so the band's size,
    and no band while maximized or full screen, are the app window's own), and the page's content everywhere else.
    Chromium would take the press that follows as a page press, so the engine's message hook (`PreTranslate` in
    `ardia/win/main.cc`, called before Chromium's pump dispatches) takes a hosted page's non-client press and double
    click with those codes: the press becomes the app window's own size command, the double click the app window's.
    A move in the band sets the resize cursor (Chromium's page child window answers WM_SETCURSOR with nothing) and still
    reaches Chromium. Chromium arms its non-client leave tracking on the page's top-level window, which never sees the
    pointer leave from over its child, so the hook arms it on the child itself and, when the child reports the pointer
    left the page, sends the page window WM_MOUSELEAVE: a page's hover ends when the pointer leaves through the band. Touch and pen can't resize from the top edge over a page: their contact arrives as WM_NCPOINTERDOWN,
    which Chromium handles (untried without a touch device). `HTTOP` alone (Chromium handles the press) and
    `HTTRANSPARENT` (a child window's transparency doesn't reach another top-level window) both left the window
    unresized in a real drag. `launch-smoke.ps1` drags the band over a page in Minimalism with the sidebar on the
    right and expects the window to resize from the top; the `tab.hitTest` host verb answers the page's and the app
    window's hit for the self-check.
  - Moving the window: a drag region is a view that moves the window when the UI's own hit-testing gives it the press,
    so a control on top of it still clicks, and the app moves the window while the button is down (Escape puts it
    back, a maximized window restores under the pointer, a release at the top edge maximizes). The UI also marks
    caption regions for Windows (`captionRegions` in `state/windows/layout.ts`, sent by `state/windows/captionRegions.ts`
    through `platform/windowControls.windows.ts`): the gap beside the window buttons and the gutter above the card,
    where nothing else sits. Windows moves the window itself from those, so its snap, drag off a maximized window,
    double click to maximize and system menu work, and each press still reaches the UI so popovers and the command
    panel close. No region is marked while the command panel, the downloads popover or onboarding is open. Native lays
    a pass-through over the rest of any band Windows would treat as a title bar. The launch log says
    `input regions of <id>: ...`, `title band of <id> is caption|content` (caption while any region is marked),
    which path each drag took, and `maximized|restored <id>`.
  - A hidden sidebar slides back in when the pointer reaches the window's edge, as on the Mac: `watchSidebarEdge`
    polls the pointer every 40 ms while a window is watched and logs `sidebar edge over|away <id>`.
  - React Native for Windows hit-tests by layout and ignores `transform`, and the app runs every animation that
    doesn't repeat from JS on Windows, so a running animation keeps writing its values to a view until it ends. So a
    style never swaps an Animated value for a constant while an animation may still write to it: the view keeps the
    same node, and `useGated` (`components/ui/motion.ts`) pins that node to its resting value while its state is off.
    A sidebar docked while its peek was closing drew its rows off where they click before this (#1852); the self-check
    `sidebar peek layer rests at identity after docking mid-close` docks the first window six times as its peek
    closes and logs `self-check note: sidebar peek, <n> cycles, <m> docked mid-close, ...`. And no view that takes
    clicks rests under a non-zero transform (#1868).
  - The app quits when its last window closes: it sends `willQuit`, then quits on the UI's yes or after 3 seconds
    without a reply; a no cancels the quit.
  - Warn before quitting asks when closing a browser window would quit the app: the setting is on, the instance
    isn't hidden, and no other window stays open: `windowIds()` less the browser windows the UI has closed or is
    closing (Settings, Import and pop-up windows count while listed). A pop-up keeps Ardia running like any window:
    closing the last browser window with a pop-up open neither asks nor quits, and the user closing that pop-up (its
    button, Alt+F4, Ctrl+W, the system menu) is the close that quits and asks. A page that closes itself
    (`window.close()`) closes its pop-up window at once, so in the last window it quits without asking: the question
    protects what is still open, and nothing is. Little Ardia's own closes (Ctrl+W, Escape) and Ctrl+W on a
    window's last tab ask the same way; when the last-tab confirm asks, it stands in for the quit question.
    Windows has no Quit command, so these are the only places it asks; the Mac asks on ⌘Q and never on a window's
    close. It asks before the window closes, so a Cancel leaves the window and the app as they were and no quit
    starts; Quit closes the window and the quit above runs as before. A close that asked it never also shows the
    close-tabs confirm. The dialog is the shared confirm on the dialog thread (#1672). Closing Settings when it is
    the only window left quits without asking: Settings closes without a close request (#1803). When another window
    closes while a close-tabs confirm is open, confirming it asks the quit question too, since that close now quits:
    the only close that shows both dialogs (#1889; `quit_warnings_after_tabs_confirm` and its `_cancelled` count them).
  - Windows fade as on the Mac (`WindowFade.h`), fade only with no grow. A window opened with `animated`, and every
    window that is not a browser window (Little Ardia, Settings, Import: the Mac's system animates those open),
    stays transparent until its React root has content or for 0.6 s, then fades in over 0.25 s (Little Ardia
    0.20 s); `animateWindowClose` fades it out from where it is over 0.18 s (0.15 s), hides it and then
    resolves. With `after` naming a new window it waits for that window to appear plus 0.20 s and hides at once. The
    fade makes the app window and every visible window it owns (the page windows) layered for its length and puts
    their styles back at the end; on the way out they ignore clicks, and pages still shown after the hide stay
    transparent until the engine hides them (at most 2 s). A minimized, full screen or not yet shown window, or
    Windows' "Animation effects" off, shows and hides at once. The launch log says `window <id> fades in over <ms> ms
    with <n> page windows`, `window <id> shown`, `window <id> fades out over <ms> ms`, `window <id> hidden` and
    `window <id> hidden at once: <reason>`.
- What has a C++ version: windows, documents, config files and their watcher, secrets (Credential Manager), local
  telemetry, launch config and system info, file actions and icons, launch at login, the theme, lock and sleep
  signals, the clipboard, the bang list, confirm, prompt and file dialogs, the command table with its shortcuts and
  context menus, the Escape and tab switcher key captures, icons, file and link drops, notifications, and the file, SQLite
  and key primitives behind importing another browser's data (Import from another browser, below).
- File and link drops: each browser window's top-level window and its child windows take OLE drops (`FileDropTarget.h`).
  Every `FileDropArea` reports its frame in the window to native as it mounts, lays out and changes, and again when a
  drag enters the window; native picks the innermost enabled area under the pointer, so the cursor shows copy or no
  drop at once, and reads files (`CF_HDROP`), links (`UniformResourceLocatorW`) and text (`CF_UNICODETEXT`) with the
  Mac's rules for each accept mode (`FileDropItems.h`), `.url` and `.webloc` files included. The area gets the Mac's
  enter, move, exit and drop updates. Dragging a file out of the app is not built yet, so `devLastFileDrag` is empty.
- The app's identity (`AppIcon.h`): at startup the process takes the AppUserModelID `Ardia.Browser`, the one the
  installer's Start menu and desktop shortcuts carry, so the taskbar groups every window under that shortcut, uses its
  icon, and a pin made from a running window relaunches Ardia. Every window the app opens gets Ardia's icon from the
  library's resources (`WM_SETICON`, big and small at the window's DPI), and notifications register with the name
  Ardia and a PNG of that icon written to the data folder. The launch log says `app icon: AppUserModelID is ...`
  (and what it was) and `app icon: set on <id>`. `scripts/windows/launcher-identity.ps1` gives the engine's launcher
  Ardia's icon as its first icon group and Ardia's name in its version strings (Task Manager shows the
  FileDescription); `assemble.ps1` runs it, and `-Check` only reads it back.
- Notifications are Windows App SDK app notifications (`NotificationCenter.h`): the app registers at startup, before
  the first window, which also registers its toast activator for this unpackaged app, so a click on a toast reaches
  the running app or launches it. Clicks are held until a window is open, then sent as `onNotificationResponse`.
  Windows has no permission prompt: the system setting for the app is the answer. A background instance registers
  but logs toasts instead of showing them. Windows reports no dismissals, so there is no `close` response. If
  registration fails, notifications answer as not set up and the launch log says why once.
- A press reaches the UI as a touch with no button: pointer events never arrive, and the app's pointer input does not
  pass through the UI thread's message queue. So the window root (`OutsidePressRoot` in `src/views/inputAreas.tsx`)
  asks native which button is down when a touch starts (`ArdiaWindowsHost.pointerState`), and for a right or middle
  press it takes the press, finds the context menu or middle click area under the real target, and acts on release.
- Shortcuts are the Mac's with Command as Ctrl and Option as Alt, except where Windows has its own convention;
  `CommandTable.h` holds both columns. The JS command catalog still shows the Mac keys in Settings.
- Escape reaches a focused field or dialog through React Native's own key events, which is how the command bar and
  Search Tabs close. A popover with nothing focused in it needs the key captured, as the Mac's key monitor does:
  while the UI holds Escape (`captureEscape` in `platform/focus.ts`, for a page popover, a sidebar or bookmarks bar
  drag, and on Windows the Downloads popover too), `ArdiaFocus.setDragEscapeCapture` (`FocusModule.h`) has the
  keyboard hook in `MenuKeyboard.h` take a bare Escape in an Ardia window and send `dragEscape`. While the tab
  switcher is open the hook takes every key, as on the Mac: Escape and the left and right arrows go to the switcher,
  W with Ctrl held (with or without Shift, never with Alt or as a key repeat) closes its highlighted row, and its own
  shortcut still runs. The launch log says `keys escape capture on|off` and
  `keys escape sent to the open popover or drag`. The Mac's Downloads popover does not close on Escape yet
  (`PLATFORM_FEATURES.escapeClosesDownloads` is off there).
- The new tab's bar takes the keyboard about 50 ms after Ctrl+T (#2098). It used to take it only on its first layout,
  60 to 280 ms after the command on CI's runner, after the whole New Tab page had mounted, and the letters typed
  before then went to the previous tab's hidden bar.
  - **The change:** with `PLATFORM_FEATURES.newTabBarFirst` (Windows only; the Mac and Linux keep today's order), a
    fresh New Tab page commits its bar alone, and the bar focuses in its commit's layout effect, with the layout event
    as the fallback. The rest of the page (the logo mark, the intro glow, the bar's shadows, `NewTabExtras`) mounts a
    frame after the bar lays out.
  - **Launch log:** `new tab bar page|committed|focused|rest|typed <tab>` (`platform/newTabMarks.windows.ts`);
    `typed` is the bar's first typed change, once per page.
  - **Tour:** the `first-run` part of `scripts/windows/tour.ps1` presses Ctrl+T and types the first key 100 ms later,
    in fresh launches after Get Started, during and after the tool tour, under CPU and disk load, and with the Go
    button. A stop fails only when the new tab's bar takes focus more than 90 ms after the `newTab` command (the
    worst seen was 69 ms under load), or the first key does not land in the new tab's bar (its first `typed` mark
    after the command, and the settled text starting with that key). A stop typing from 15 ms after Ctrl+T
    must keep every key (#2099). The rest is report only: the whole text at 30 ms a key (#2101), where Go goes
    (#2102), and three launches each typing at 80 and at 120 ms a key that read the field after every key.
  - **A stalled JS thread** (a slow first launch, #2059) is covered by the key hold below (#2099).
- The command bar puts back a letter its text field drops (#2101). React Native Windows 0.81's text field applies
  the state of its first change (event count 0) whenever that state mounts. When JS is busy, as right after Ctrl+T,
  the state lands after the next letter and wipes it: "example.com" became "eample.com" in 2 of 10 tries at 80 ms a
  key and 2 of 10 at 120 ms. React Native Windows fixed it with React Native 0.88 (commit 1f59db13f9), not in 0.81.40,
  and the app uses its prebuilt package, so the bar repairs it instead.
  - **Where it is lost:** in the control itself. UI Automation reads the RichEdit text live, and it read "ea" while
    the change events had said "ex" and JS had written nothing.
  - **The repair:** with `PLATFORM_FEATURES.textInputRevertsFirstChange` (Windows only), `useRevertRepair` acts only
    when the change events prove which letters went where (`components/omnibox/revertedText.ts`):
    - every change since the empty field was one letter typed at the end, with the caret there;
    - JS never wrote the field;
    - it is within 3 s of the first change;
    - the field drops back to its first change plus one new letter;
    - every character involved is printable ASCII, so an IME composition that turns typed letters into か or ê never
      looks like a revert;
    - the new text is not a strict prefix of the old one, which Backspace could also make.

    A new text equal to the old one counts: a typed letter has to change the text, so "go" after "go" proves the
    second "o" came after a revert. It puts the lost letters back where they were and moves the caret after them,
    since React Native keeps the old caret position. It keeps doing so until native shows the restored text, and
    stops at any edit that isn't one letter typed at the end. A paste, a selection, Backspace, a completion or any
    JS write turns it off for that field. It acts at most once per field. The proof comes from the change events
    alone; it doesn't use key events.
  - **Launch log:** `bar change <variant> #<count> len <n>`, `bar write <variant> len <n> over native len <m>`,
    `bar repair <variant> native len <n> to len <m>`, `bar suggestions <ms> ms`, `js stall <ms>` after a New Tab
    page mounts, `new tab bar gone <tab>` and `new tab pane <tab> mounted|gone|<flags>`
    (`platform/barMarks.windows.ts`, `platform/newTabMarks.windows.ts`).
  - **Tour:** these are required to lose no letter:
    - ten first-run launches each at 80 and 120 ms a key;
    - in the `typing` part, ten tries each into Ctrl+L's field on a page, a warm Ctrl+T, the top-tabs toolbar field
      and the floating bar.

    The per-key reads name the focused UI Automation element.
  - **Telemetry:** `command_bar_letters_restored` in `usage_counts`, counted once per field the repair acted on.
- A window's views mount only after the React instance finishes loading (#2115, `InstanceLoad.h`). React Native
  Windows 0.81's `ReactNativeIsland::ShowInstanceLoaded` starts a new surface each time it runs. It runs when a view
  host attaches to an instance already marked Loaded, and again when the host's `whenLoaded` continuation updates
  every attached view host. A window that attached between the two got two copies of the app, both alive: every New
  Tab page mounted twice, and the first letter typed after Ctrl+T went into the copy that then lost focus. It
  happened in 3 of 27 first-run launches in run 43786493639; each of those logged `Running "main"` twice. `Open` now
  mounts a window that comes before `ReloadInstance()` completes once it has completed, and logs
  `window <id> waited <ms> ms for the instance to finish loading`. `window_roots_doubled` in `usage_counts` counts a
  window whose root mounts while another root for it is still up.
- The keys typed right after Ctrl+T or Ctrl+L wait for the bar's field (#2099, #2124). The keyboard hook runs on the UI
  thread and handles a typed key before the queued mount that focuses the new bar, so a key typed then went into the
  old, dying field or nowhere: 1 of 20 first letters with #2060's mount order and 3 of 20 with main's, at 80 and
  120 ms a key. `FocusHold.h` holds them, through the Mac's focus-handoff contract:
  - **Start:** `MenuKeyboard::Emit` gives `newTab` and `focusCommandBar` a `focusGeneration` when the window is
    visible and in front. Another command ends the hold.
  - **Ready:** `ArdiaFocus.claimFocus(generation, tag)` names the field, and that field reports native focus
    (`src/textFocus.ts` calls `fieldFocused`/`fieldBlurred` from `TextInputState.focusInput`, `blurInput` and
    `unregisterInput`). Windows can't focus a view by tag natively, so it needs both. With
    `PLATFORM_FEATURES.claimsFollowFocus`, a bar field that already has focus claims when the move asks for it (Ctrl+L
    on an open bar, a hero bar asked again), and a field claims again when it takes focus. The contract's missing part
    is #989's acknowledgement; until it lands, a hold gives up 3 s after the command.
  - **Held:** character keys with no Ctrl, Alt or Win, turned into characters when recorded (`ToUnicodeEx` with flag 4,
    so the dead-key state is left alone). Modifiers pass. At most 64.
  - **Replay:** one `WM_CHAR` at a time (a surrogate pair together) posted to the focused `InputSiteWindowClass`
    window, then a sentinel to the hold's own message window, re-checking the window in front and the focus before the
    next, waiting 50 ms after the first one's sentinel returns so the field's first change settles before a second letter can meet #2101's
    revert. No `SendInput`. A failed post, or a sentinel not back within 1 s, ends the hold. A posted character can't be
    recalled, and the check sees the input window, not which React field inside it has focus. So `src/textFocus.ts`
    also tells the hold when JS asks another field to take focus (`fieldAsked`, sent before the request; a request
    before the claim is kept and checked against it), which should end the hold before that move reaches the UI
    thread: the report is sent first, but that it arrives before Fabric's focus command is expected, not proven. What's left: a focus move inside the window that doesn't come
    from JS can take characters until the new field's focus report arrives, and a click inside the bar's own field
    while the replay runs can put a held letter where the click left the caret (Composition clicks reach none of the
    hold's hooks).
  - **No second writer during a replay:** when a hold is ready with keys held, `ArdiaFocus` sends the app event
    `keyHoldReplay` with the field's tag and the count, and again with 0 when the replay ends or the hold drops.
    Until then that field's bar shows no inline completion and writes none (`state/omnibox/keyHoldReplay.ts`, with a
    2 s guard so a lost end can't leave completion off); then it computes completion once for the text it has.
  - **A typed text is never read as a completion's echo on Windows:** a value write from JS fires no change event
    there, so `PLATFORM_FEATURES.inlineWritesEcho` is off and `useInlineCompletion` doesn't match changes against its
    pending completion writes. Before, the whole completion arriving as typed text ("example.com" after a completion
    computed for "e" that hadn't settled) was read as that old write's echo; the bar kept "example.co" and its next
    render wrote that over the field. Replayed letters made it likely; a person typing the rest of a completion before
    it settles could hit it too.
  - **Ends a hold, dropping what it holds and passing the key on:** Ctrl, Alt or Win going down, or a key with them
    (so AltGr characters and Ctrl+V right after Ctrl+T aren't held; the Ctrl still down from Ctrl+T doesn't count); Backspace and Enter, since a posted key event can't be ordered by the
    sentinel; a key without a character (Escape, Tab, arrows, function keys); a dead key, `VK_PROCESSKEY` or
    `VK_PACKET`; a mouse button; another window in front or the window closing; the move cancelled; another field
    asked to take focus or taking it; a reload; 64 keys; 3 s. The foreground hook watches every process, so leaving for another program
    ends the hold even while the UI thread is busy. A key whose press was held owes its release to the hold; after a
    drop its repeats stay swallowed until it's released, even across a new hold. A dead key already
    pending before Ctrl+T isn't protected.
  - **Launch log:** `keys hold <g> begun for <command>`, `keys hold <g> ready after <ms> ms, replayed <n>` and
    `keys hold <g> dropped: <why> with <n> held, <m> replayed`.
  - **Tour:** the first-letter stop (ten tries each at 80 and 120 ms a key) and the 15 ms stop are required, at the
    runner's own timing. The `hold-*` stops in the typing part launch with `ARDIA_TEST=keyHoldReadyMs=400`, which keeps
    a hold from being ready for 400 ms (a slow launch; a warm runner is ready in about 50 ms), so each path runs: all of
    example.com replayed in ten of ten tries (and ten more at the runner's own timing, no floor), capitals from Shift
    and Caps Lock, and drops on Backspace, Escape, a click into another
    window of ours and Notepad taking the keyboard, each logged with keys held. Ctrl+V passes through.
  - **Telemetry:** `command_bar_key_holds`, `command_bar_keys_replayed` and `command_bar_key_hold_drops_<reason>` in
    `usage_counts`.
- "Ctrl+Z reopens closed tabs" works as the Mac's retargeted Undo: with the setting on, the keyboard hook in
  `MenuKeyboard.h` sends `reopenClosedTab` for a plain Ctrl+Z in a browser window (Little Ardia included, Settings and
  Import not) when Reopen isn't disabled, no command is bound to Ctrl+Z, the window itself is the active one (not a
  dialog it owns, such as a prompt, nor a page), and no text field of the app has focus. Everything else keeps Ctrl+Z:
  a text field or a dialog's edit box undoes typing, a page gets its own undo, a command bound to Ctrl+Z runs. The app's text fields are React Native `TextInput`s
  inside the island, which Win32 focus can't tell apart, so `src/textFocus.ts` wraps React Native's
  `TextInputState.focusInput`/`blurInput` and tells `ArdiaFocus.setTextInputFocused`; a page is a Chromium window on the
  same thread, so the hook reads the focused window's class (`Chrome_*`). The launch log says `ctrl+z reopens the last
  closed tab`, `ctrl+z left to the focused text field`, `ctrl+z left to the focused dialog or page` or `ctrl+z left to the focused page`.
- Animations run in JavaScript on Windows (`packages/expo-windows/src/animation`). React Native for Windows' native
  animation driver adds what it animates to the view's own style instead of replacing it, turns a scale around the
  top-left corner, never reports where an animation ended, and drops scroll and gesture events, so anything but a
  plain fade started doubled, ended in the wrong place or did not move. `installAnimation` therefore answers
  `useNativeDriver: true` with the JS driver, which sets the view's real props every frame, as the sidebar's slide
  always did. The exceptions are endless loops of one animation (the loading and refresh spinners), which stay native
  and cost the JS thread nothing.
  - Frames are paced: React Native's `requestAnimationFrame` is a zero timeout here, so an animation would step as
    fast as the threads allow. `motion.ts` runs every frame callback of a turn together, 60 times a second.
  - A scale, rotation or skew turns around the view's centre, as on the Mac: React Native for Windows applies a
    transform from the top-left corner, so `pivot.ts` wraps any transform that is not at rest in a half-size translate
    there and back. `transformOrigin` then means what it means on the Mac, and the command panel grows out of its
    field as it does there.
  - While an animation runs, every shown page and every surface over a page is measured again each frame
    (`followMotion`), so the page window and the holes cut in it follow what moves: the toolbar that hides while
    scrolling, a peek, a popover that grows in. Endless loops do not count.
  - The launch log says `[ardia windows] motion <n> frames in <ms> ms, longest <ms> ms, <n> long` when a burst of
    animation ends: how many frames it got, the longest gap between two, and how many gaps were over 2.5 frames.
    The same numbers go to telemetry, where sharing is on, as `animation_bursts` and `animation_long_frames` in the
    hourly `usage_counts` (`platform/motion.windows.ts`, the `ArdiaMotion` module): a rising share of long frames
    per burst is the sign that animations stutter in the field.
  - What this costs and where it is not exact:
    - An animation needs the UI thread: while the engine opens its first page (most of a second) a row's slide
      stalls and then jumps. The Mac's native driver keeps going there.
    - A value that an endless loop animates natively must not be animated any other way afterwards, and nothing
      else may share its view's animated props: React Native refuses to mix the two drivers on one value.
    - While a view is scaled, `measureInWindow` reports it half its size times (1 - scale) further right and down
      than it is drawn, because React Native measures as if the platform turned around the centre by itself. So a
      hole cut for a surface that is growing in sits off by that much until the scale reaches 1 (a popover: under
      a tenth of its size, for 150 ms).
    - A surface that fades in over a page shows the card through its hole for a frame or two first: the hole is
      cut when the surface mounts, before its fade is visible, and the page, being a window above the UI, cannot
      be faded over.
    - React Native for Windows resolves the half-size translate when the transform changes, not when the view's
      size changes: a view that is resized while it holds a scale or rotation keeps turning around its old centre
      until its transform changes again. An animation changes it every frame; a fixed rotation on a view that
      resizes would need its transform set again.
- While the command panel sits beside the window buttons it keeps their 138 points free at the right
  (`trailingClearance` in `lib/windowChrome.ts`). Little Ardia's bar numbers for both systems are in
  `components/littleArdia/barLayout.ts`.
- Icons are the web demo's set (`packages/demo/src/shims/web/symbols`), resolved in TypeScript and drawn natively as
  Direct2D geometry in Composition shapes.
- Materials are native views (`MaterialViews.h`, the `ArdiaMaterials` module in `MaterialsModule.h`), each with the old
  flat drawing as its fallback. A window backdrop that covers its whole window asks the system for Mica Alt behind the
  window on Windows 11 22H2 (build 22621) and later and draws the Mac's tint over it. Visual effects, glass and popover
  bubbles blur what is under them inside the window with a Composition backdrop brush (Gaussian blur, saturation and a
  tint). Window and theme gradients are Composition linear gradients at their real angle. Windows 10, a background
  instance and any failure keep the flat colours; the launch log says once which path each one took.
- Switching profiles slides the sidebar's pages and crossfades the tint as on the Mac. The Mac's native pager
  (`Pager.swift`) has a TypeScript version in `packages/expo-windows/src/pager`: the `ArdiaSwipe` view and module with
  the same events (`onPagerPosition` every frame, `onPagerState` on select and settle), sequence numbers and spring
  (critically damped, a quarter-second period), stepped on the app's 60 Hz frames. With Windows' animations off it
  lands at once. Swipe gestures (two-finger scroll, the rubber band, haptics) have no input on Windows yet, so only
  clicks, shortcuts and outside switches page.
- Shadows of the views drawn in TypeScript (`Surface`, popover bubbles) are rounded rings drawn behind the fill
  (`src/views/shadowLayers.ts`), fading like a Gaussian blur of the edge: React Native for Windows casts a view's shadow
  from its rectangle whatever its corner radius, which left grey square corners behind the new tab's command bar.
- The Windows native API has its own version: `WINDOWS_NATIVE_API_VERSION` in `platform/nativeApi.ts` and
  `windowsApiVersion` in `AppModule.h`. Bump both when the Windows native surface changes. A Mac bump doesn't
  touch it.
- The app writes its launch log, React Native's log and JavaScript errors to `Logs\launch.log` in the data folder
  (`%LOCALAPPDATA%\Ardia\Logs`), or to `--log-file=<path>` when given. Each line is `<level> <ms since process start>
  <message>`; the engine's lines are `engine 0 <message>`, and a crash's stack lands there too. Each start moves the
  last run's log to `launch.previous.log`, and a run stops writing at 16 MB. A problem report from someone whose Ardia
  won't open starts with those two files.
- A background instance (`ARDIA_BACKGROUND=1`) shows its windows without taking focus and answers dialogs and menus
  without showing them, as on the Mac.

## The engine in the app

The engine is Chromium's own browser, built for Windows with our patches (`docs/engine-build-windows.md`). The product
is one folder: Chromium's launcher as `Ardia.exe`, `chrome.dll`, and the app's library and files beside them
(`scripts/windows/assemble.ps1` puts an engine and the app's build output together and gives the launcher the app's
manifest entries). With `ArdiaApp.dll` beside the launcher the browser process runs the app; without it the same build
is plain Chromium.

- Features the engine turns off at launch (`AddLaunchSwitches` in `scripts/windows/engine/src/ardia/win/main.cc`,
  appended to any `--disable-features` the launcher passed, which a launcher's `--enable-features` can't undo):
  `CalculateNativeWinOcclusion`, and `SettingsGlowupJourneys` (engine `windows-engine-20261117-9`, #2326). The latter
  feeds Chrome's own guided tours, which Ardia never shows, and its chrome://settings handlers CHECK for a tracked
  browser view in the tab's window, which a hidden page window doesn't have. The Mac turns it off too (#2289). The
  `engine settings:` self-checks change a search engine, a site permission, the theme and browsing data through
  chrome://settings in shown, private, pop-up and hidden pages and ask the engine for the page after each.
- A browser-theme change (chrome://settings › Appearance › Reset to default, a theme installed or removed) leaves a
  hosted page window's frame alone (`chromium-win-hosted-theme-change.patch`, engine `windows-engine-20261117-9`,
  #2332). Chromium regenerates the frame on Windows for every theme change, which asks the window for a DWM frame
  transition; a hosted window's frame is custom drawn, so that ended in a failed CHECK that closed the app.
- The Visual C++ runtime ships inside the folder. React Native's DLLs import the app-container CRT (`vcruntime140_app.dll`,
  `msvcp140_app.dll` and the other `*_app.dll`), whose exports forward to the desktop `VCRUNTIME140.dll`, `MSVCP140.dll`
  and friends. A clean Windows 11 has none of those, and the per-user installer can't run `vc_redist`, so
  `assemble.ps1` (`vc-runtime.ps1`) reads every PE file's imports, delay-loads and forwarded exports and copies each
  redist DLL they reach from the build machine's Visual Studio (`VC\Redist\MSVC\<version>\<cpu>`, the version from
  `Microsoft.VCRedistVersion.default.txt`, found with vswhere; `-VcRedist <folder>` overrides it), for the launcher's
  CPU (all nine on x64, eight on ARM64, which has no `vcruntime140_1`). A forwarder whose target the redist lacks is left
  out when nothing loads it, and fails the assembly when something does. Without this the app fails with "Class not registered" on a machine without the VC++ redist, and GitHub's
  runners have it, so only `dependency-check.ps1` below catches it in CI (#2036).

- `//ardia/win` (`scripts/windows/engine/src/ardia/win`, copied into the tree by `series_win.py`) is the engine's side.
  It starts Chromium with no window of its own, turns the launch variables into switches as the Mac's launcher does
  (`ARDIA_DATA_DIR` keeps Chromium's data in `<dir>\Chromium`; `ARDIA_REMOTE_DEBUGGING_PORT`, `ARDIA_TEST` and
  `ARDIA_TRACE` only count in a test instance, see Test instances; a remote debugging switch or an Ardia test switch on
  the command line is dropped), loads the app's library once the browser has started, and hands it the API in
  `EngineApi.h`: `hostCall(verb, json, window)`, `engineCall(name, profile, json)`, one event sink and
  `testGateRefusal()`, the engine's test-instance decision. Chromium's message loop offers each message to the app first, except messages for Chromium's own windows.
- Every normal browser window Chromium has is hosted: page only, with no frame, tab strip, toolbar, rounded page frame
  or shortcuts of its own (the `chromium-win-hosted-*` patches), and each shows one page: its active tab. Each is
  a borderless top-level window owned by the app's window, placed over the page's view: it stays above its owner, hides
  and minimizes with it, and follows it when it moves. It cannot be a child window: with the Windows App SDK in a
  window, no mouse message for a child of it reaches the UI thread (`ARDIA_INPUT_TRACE=<file>` logs what does). Being
  top-level, it is what a window tool finds under the pointer (AltSnap's Alt+drag, a script posting SC_MOVE), so while a page
  is shown and not fullscreen its window holds its place: the host's own placement is the only move or resize it takes,
  a change that skipped WM_WINDOWPOSCHANGING (SWP_NOSENDCHANGING) is put back, and a system move or size started on it
  goes to the app window (#2051, `Test-PageHoldsPlace` in `launch-smoke.ps1`). The guard stays on the window through Memory
  Saver: a hidden page that sleeps keeps it, and the page holds its place again once it wakes (`engineSleepPlace.ts`). A window
  Chromium opens by itself (a link opened in a new window) stays off screen until the app adopts its tabs.
- The verbs: `tab.create` (a key, a profile, a URL or a tab to adopt; the same key again moves the tab to the window
  that asks), `tab.show` (visible, and where in the window, in the UI's points; a corner radius and holes),
  `tab.close`, `tab.call` (load, back, forward, reload, stop, find, zoom, scripts, DevTools, print, site info and the
  rest of the Mac tab's methods, `tab_calls.cc`), `tab.discard`, `tabs.list`, `host.info`, `app.quit`. Events come as
  the topic `tab` with a key, a name and data (navigation, progress, favicon, find, zoom, security, media, pagePress,
  windowClose and more), and `tab.opened` for a tab Chromium made itself, with who opened it.
- `tab.close` closes as the Mac's `TabBridge::CloseAfterUnloadHandlers` does: a page with `beforeunload` or `unload`
  handlers gets `beforeunload` with its prompt cancelled (no "Leave site?" is ever shown for a tab the app closed), then
  its unload handlers whatever it answered, each step with 2 seconds, and then the host deletes the tab
  (`Host::DeleteClosedTab`, kept for Reopen Closed Tab unless it only ever showed its opening blank page). While
  quitting, only the unload step runs. The closed tab gives up its key when `tab.close` answers: nothing it does
  during its deadlines reaches the app, and the app may open a new tab under the same key at once.
- The `ac_*` calls of `engine/chromium` build on Windows from the same sources: `series_win.py` makes the Windows
  build file from the Mac one, applies `ardia-layer-win.patch` (paths from UTF-8, a Mac-only string, and Windows absolute paths, a drive letter
  or UNC, accepted where the Mac asks for a leading `/`: extension installs, bookmark and password exports) and swaps in
  Windows stand-ins for the two POSIX-only files (the `ardia` command's control file and the user scripts policy, both
  off). `engineCall` loads the profile the app names and calls the export by name. `engine/` is not touched.
- In the app (`packages/expo-windows/src/engine`): `ArdiaWebView` is a view in TypeScript. It opens its tab on mount,
  measures itself and shows the page there, turns the engine's events into page events and parks or closes the tab on
  unmount as `ArdiaTabs` asks. The domain modules (`domains/`) answer `call` as the Mac's Swift tables do, on top of
  `engineCall`; `windowsEngineCalls.test.mjs` fails when a forwarded verb differs from the Mac's.
- The page is a window above the UI, so the UI cannot draw over it. Every shadowed surface (the command bar, popovers,
  the find bar, dialogs, toasts, the downloads bubble) reports its rectangle (`usePageCover`), and the page window gets
  a hole there, with the surface's corners. A surface inside a `ClipView` (the sidebar's and the tab strip's profile
  pages, which sit side by side and clip to one) reports only the part its clips show, so the next profile's rows,
  parked beside the sidebar, cut nothing in the page (#1673). A translucent surface shows the card behind it in the hole, not the page.
  A `Surface` that only draws a gradient (`GradientFill`, the address field's load glow) reports no rectangle: it always
  sits inside a toolbar, sidebar or Little Ardia plate that does, and `windowsGradientFill.test.mjs` pins its callers.
  Gradients draw through `ArdiaMaterialGradient` (`GradientView.h`): `fillColors` at `fillStops` top to bottom, masked
  left to right by `fade` at `fadeStops` through a `CompositionMaskBrush`, as `Surface.swift` masks its plate. When
  composition gradients fail, `Surface` draws rows at the stops inside columns that carry the fade.
  The page window has no system backdrop: Chromium asks for Mica on its top-level windows, and Windows paints that
  into the holes. While a modal the app shows is open (a confirm, a prompt, a file or folder picker), the page windows its
  window owns are disabled and enabled again when it closes, so a click on the page cannot raise it over the dialog. A press in the page counts
  as a press outside every popover of its window.
- Native modals (confirm and alert, the prompt, the open, save and folder pickers; `NativeDialogs.h`, `SaveDialog.h`)
  run on a thread of their own (`ModalThread.h` `RunModal`, a COM STA thread), never on the UI thread. The app shares
  that thread with Chromium's browser UI, and Chromium runs none of its own tasks inside a native modal loop, so a
  dialog there stalled every window's pages until it closed (#1672: in the VM, Chromium's DevTools list gave no answer
  for 5 s while "Close 2 tabs?" was open and a page asked in another window stayed "Untitled"). No dialog is owned by
  a window on another thread: that joins the two threads' input queues, and WinAppSDK's input (`Microsoft.UI.Input.dll`)
  then fails fast (`0xc0000602`) when the app quits. The dialog thread owns the dialog by a hidden window of its own
  over the app window (`ModalParent`), disables the app window and its pages, keeps the dialog just above the app
  window and gives the window its focus back when it closes. When the app window is activated (its taskbar button,
  Alt+Tab, or the app focusing it), `WindowManager` brings that window's dialog forward instead (`BringModalForward`).
  A hidden instance's dialog never hands the foreground to the app window. The app clears keyboard focus before it
  shuts down WinUI's queue (`ShutDown` in `Ardia.cpp`): destroying the input site of a focused window moves focus
  into a site being torn down, and `Microsoft.UI.Input` fails fast (`0xc0000602`, seen in a VM dump). Keys typed in it no longer reach the app's shortcut hook. One dialog per window at a time; a dialog whose window goes away, or every
  dialog when the app stops, is cancelled within 250 ms, except the open-file picker: quitting with it open waits the
  stop's full 2 s and leaves its thread running (exit code 0, no crash; #1747). The launch log notes how many dialogs
  were open at stop, how long they took and how many were left. Pop-up menus run the same way (#1687): the UI thread
  builds the menu and takes the cursor point, and `TrackPopupMenuEx` runs on a `RunModal` thread, owned by that
  thread's hidden `ModalParent` at the app window, which takes the foreground so keys and outside clicks reach the
  menu. The app window stays enabled, the `resignActive` its deactivation would send is held back
  (`ActivatesMenuThread`) and sent after the menu only if another app took the foreground, and a menu is closed
  (`EndMenu`) when its window goes or the app stops. A right press in the sidebar while a page has the keyboard
  activates the app window first, before any menu, so the page lost the keyboard to the sidebar for good (#2218, seen on
  the CI runner: the field kept its caret but `document.hasFocus()` was false and the keys went nowhere). The app window
  now remembers the page it was activated from when the secondary button was down (`TakePageLeftBySecondaryPress`). The
  sidebar's presses reach WinUI without passing the UI thread's mouse messages or a `WH_MOUSE` hook (the CI input trace
  had none and the hook was never called), so the window reads the physical buttons on a 15 ms timer from that press
  until 2 s after its release, at most 10 s held (`FollowSecondaryPress`); another button or a new right press forgets
  the page. The menu reads it on the UI thread before its thread starts (`PageTheMenuPressLeft`, within 2 s of the button release and only for
  the menu's own window), and when the menu is dismissed without a choice it gives the keyboard back through the same
  follow path the Windows key uses (`snapKeyHandedBack` with `afterMenu`), only if that window is still in front,
  enabled, not minimized and holds no dialog, the page is still that window's and shown, and no switcher, popover,
  Windows-key or command-bar hold is under way. A choice keeps today's behaviour, since its command may focus a field.
  The launch log records each request and why a request was skipped ("menu: …"), and `page_focus_return_requests_after_menu` counts the requests, including ones a focused app field or a later foreground change refuses. The self-check holds a real confirm and a real menu on both
  threads and checks that a page loads only in the first case; `dialog_pages_asked` and `dialog_pages_stalled` count
  pages asked while a dialog or a menu was open and how many hadn't loaded 10 s later.
- A launch while the previous Ardia on the same profile is still closing waits for it to end (up to 45 s) instead of
  handing its command line to a browser that is shutting down, or starting a second browser on the same profile once
  that one has let go of Chromium's process singleton (which happens before its shutdown is over: the old process
  then still writes its profile). The quitting browser signals it from `QuitApp` and from its main parts' end
  (`launch_guard.cc`, named objects under `Local\ArdiaBrowser.<hash of the user data folder>`); a launch while it runs
  normally isn't held. Without this, Chromium's own singleton took the closing browser for a hung one and killed it
  (`RESULT_CODE_HUNG`) before it had written its profile. The launch log says how long a start waited.
- When the app can't start inside the engine (its library doesn't load, it has no `ArdiaAppStart`, or that refuses),
  the engine shows why in a message box (none in a hidden instance), writes it to the launch log as
  `app start failed: <reason>`, and quits from inside the run loop, so the process exits 0. It used to call
  `QuitApp()` before the run loop and CHECK-crash at `browser_process_impl.cc:1959` with nothing on screen (#2044).
  The app hands back its reason through `ArdiaAppStartFailure`.
- A start that crashes or fails before it has run for 15 s counts as unfinished (`launch-starts.txt` in the data
  folder; a quit before then counts as finished). After two unfinished starts in a row, the next one moves the
  state Ardia restores at launch (`session.json`, `launch-look.json`, `switches-cache.json`, `bookmarks-cache.json`)
  to `Recovery\<date-time>` in the data folder, deletes Chromium's graphics caches (`GrShaderCache`,
  `GraphiteDawnCache`, `ShaderCache`, `GPUPersistentCache` and the profile's `GPUCache`, `DawnGraphiteCache`,
  `DawnWebGPUCache`: a relaunch differs from a first run in what the first session wrote there), and says so once it
  has opened, so a profile that crashes Ardia at every start opens again on its own. Chromium's profile (bookmarks,
  history, passwords, cookies) isn't touched. #2097's recording (the app gone about 4 s after its window appears, at
  every launch after onboarding) is that shape; the launch log now kept in `Logs` says what ended it.
- A window closed while minimized keeps its restored place and size for the next launch (the frame event's restored
  bounds); it used to save the minimized frame and come back as a 480 x 360 window in the corner.
- `scripts/windows/relaunch-check.ps1` (CI, after the installer check) installs the build and closes and reopens
  it: twice right away, once after it has exited, once while the previous browser is held at its exit (it must
  wait, with no second browser), once with two unfinished starts recorded (the session must be set aside), and
  once with `Microsoft.ReactNative.dll` hidden (it must exit 0 with the reason logged). Every launch must show one
  window from one browser, and Windows must log no Ardia crash, Crashpad no dump and the launch log no fatal line.
- A second launch reaches the running app: Chromium's process singleton hands it the command line, and
  `chromium-win-relaunch-to-app.patch` gives that to `//ardia/win`, which sends the topic `relaunch` with the web and
  file addresses on it. The app treats them as links from another app (`onOpenURLs`: a Little Ardia window or a tab,
  as Settings says) and a launch with none as `reopen` (the last window comes forward).
- A first launch opens the addresses it was started with, which is how a link from another app arrives when Ardia is
  the default browser and isn't running: the engine starts with `--no-startup-window`, so Chromium opens none itself.
  `ArdiaWindowsHost.launchArguments` reads the process's own command line (Chromium's `--single-argument` form, which
  the default browser registration uses, as one argument), and `packages/expo-windows/src/launchLinks` keeps what is an
  address by the relaunch's rule: switches never, http, https and file addresses, a file that exists by its full path,
  an absolute path, a bare host as http; a bare word, `localhost:<port>` and other schemes are refused. They reach the
  app as `onOpenURLs` once it listens (`emitWhenListened` in `events.ts` holds them until then; a relaunch's addresses
  go the same way), after the session has restored, so they open as links from another app do on the Mac. The launch
  log says `launch links: <n> held until the app listens` and `<n> sent to the app`; telemetry counts them as
  `launch_command_line_links` in the hourly `usage_counts`.
- Ardia is a browser Windows knows about once installed: the installer writes the per-user registration Chromium's
  own `ShellUtil` would, unsuffixed (`ArdiaHTM` is Chromium's ProgID for this install mode): the ProgID, whose open
  command is `"<app>\Ardia.exe" --single-argument %1` (the form the first-launch and relaunch paths read as one
  address), `StartMenuInternet\Ardia` with Capabilities for http, https and `.htm .html .shtml .svg .webp .xht .xhtml`,
  `RegisteredApplications\Ardia`, and `OpenWithProgids` entries, all in HKCU, all removed by the uninstaller. The
  installer does it, not the engine: Chromium registers itself only from its own installer or its settings page, and
  Ardia ships neither. `installer-check.ps1` checks every key after install and that none is left after uninstall.
- Windows 10 and 11 don't let an app make itself the default browser. `setAsDefaultBrowser` opens Default apps
  (Ardia's own page, `ms-settings:defaultapps?registeredAppUser=Ardia`, on Windows 11 when this Ardia.exe is the one
  registered; the general page otherwise) and answers false. `isDefaultBrowser` is true when the user's choice for
  http and https is `ArdiaHTM` and that ProgID opens this Ardia.exe. The choice is what the shell resolves
  (`AssocQueryString`), then the registry: Windows 11 builds since 2025 write it to `UserChoiceLatest\ProgId` and
  leave the old `UserChoice` on the previous browser, so reading `UserChoice` alone says Edge after the user chose Ardia;
  `ArdiaSystem.defaultBrowserState` returns the parts. Settings › General reads it again whenever an Ardia window
  becomes active (React Native for Windows' AppState never changes in this app). With `PLATFORM_FEATURES.setsDefaultBrowser`
  off, onboarding's row says "Yes, in Windows Settings", Settings' button says "Choose in Windows Settings…", the
  7-day trial isn't offered (it starts when Ardia becomes the default, which only Windows Settings decides, so the app
  could neither start nor date it), and the one-time offer after onboarding isn't made (it would open Settings at a
  launch nobody asked for).
- A page that goes full screen takes its window full screen (`setPageFullScreen`, which puts the window back as it
  was when the page leaves), and nothing is cut out of the page while it is.
- Every page the app shows at once has its own page window, so Split View's panes and a Peek over a page show
  together. `tab.show` makes no assumption about the window's other pages: it hides a page only when the UI says so
  (`visible: false`, sent when a page is parked, unmounted or hidden). A tab whose page window already shows another
  visible page, or belongs to another app window, moves to a free page window of that app window and profile, or to a
  new one; so an app window keeps as many page windows as it ever showed pages at once, plus one while a tab switch
  shows the new page before hiding the old. Each is placed, scaled and shaped on its own (bounds, corner radius,
  holes); pages do not overlap, because the UI cuts a hole in a page where another surface, such as the Peek card,
  sits over it. Owned windows, they minimize and move with the app window, and a press in any of them is that page's
  `pagePress`.
- The keyboard follows the user between the app's own windows, as the Mac's follows Chromium's tab activation.
  A page never takes the keyboard because it shows. When a window's shown tab changes (a tab switch, a numbered tab,
  closing the tab, a pane focus) or the user opens a Peek, the app asks that tab's (or the Peek's) page to follow, as the
  Mac's web view focuses a Peek's page when it opens (`state/focus/keyboardFollows.ts` calling
  `platform/keyboardFollow.windows.ts`; the Mac has no such call and subscribes to nothing). `pages.ts` sends it once
  the page shows, unless a text field of that window has the keyboard: React Native's focused field and the window it
  is in decide, and a field the user left by pressing a page of its window no longer counts. A field in the content
  area of another tab (its New Tab page, an empty split pane, an internal page: the views `TabPane` wraps in
  `TabContentArea`, whose `contentAreaOf` prop the field walk reads) doesn't count either, since the new page replaces
  it; the sidebar, the command bar, the find bar and the toolbar keep the keyboard. Only a page already showing
  in that window gets the ask at once. For any other page (none yet, sleeping, hidden, prewarmed, still opening, or
  still showing in the window a tab moved from) the ask is kept until that page shows in that window, however long it
  takes to open, and no show timer is involved (`engine/keptFollow.ts`, #1689, not seen on Windows yet). A shown tab
  that gets its first address (Enter in its New Tab page's search box, or in the command bar over it) asks again.
  Escape in the command bar over a page gives that page the keyboard back, as on the Mac (#1894): the page's
  `focusIfUnfocused` asks the same way, and only when no field of the window holds the keyboard (not seen on Windows
  yet; `page_focus_returns_after_bar` counts it).
  The ask is used once. It is dropped when another tab is followed or focused, a page is pressed, or a field takes the
  keyboard or holds it when the page shows: the rule above for fields of the page's window, so another tab's content
  area doesn't count, and any field at all in another window, such as Settings. `keyboard_follows_kept`,
  `keyboard_follows_used` and `keyboard_follows_dropped` in the hourly `usage_counts` count them. The engine host carries
  it out only if the keyboard is already in that app window (its own UI or its pages), only while one of the app's
  windows is the foreground window, and never in a background instance. A focus it can't carry out because Ardia
  isn't in front is kept for that window and given when the window is activated again; it is dropped when the window
  closes, a field of the window takes the keyboard (`keyboard.forget`), another page of the window is asked or
  pressed, or the page hides. When a page that holds the keyboard hides, the keyboard goes to its app window. When an
  app text field is focused while the keyboard is in a page of the field's own window (the command bar, the find bar,
  an empty pane's search field), `ArdiaFocus.takeKeyboardFromPage` activates that window. A page that hides or
  closes leaves full screen, as the Mac's does.
- Win+Up, Win+Down, Win+Left, Win+Right, Win+Z and their chains work while a page has the keyboard, as natively as
  with the sidebar (#2148). The shell acts on the window that was in front when the Windows key went down (CI showed
  an arrow sent later, with the app window in front, still ignored), and a page's own window can't be snapped, so
  nothing moved. `MenuKeyboard`'s thread hook sees the Windows key go down over a page; when the foreground window is
  then a page window owned by one of the app's browser or Little Ardia windows (and the instance isn't a background
  one; a pop-up window's page keeps today's behaviour), the app window takes the foreground at once (same thread, so
  nothing is taken from another app) and the hook remembers the page. The user's own keys then reach the shell with
  the app window as its target; nothing is ever sent with `SendInput`, so the shell acts on the arrow's key-down, a
  held arrow repeats, Win+Left then Up in one press works, and Snap Assist and the snap layouts are the system's. The
  keyboard goes back to the remembered page through the follow path (`snapKeyHandedBack` to `followHandedBack`, which
  asks the window's Peek page, or else its shown tab, to follow): at once on the key-up of any other key pressed with
  the Windows key (V, the period, H, a letter, a digit), so clipboard history, the emoji panel and dictation still
  type into the page; 150 ms after the Windows key is let go if the app window is still in front and not minimized;
  or, when Start, Snap Assist or another program came to the front, as soon as the app window is in front again. The
  shell eats the Windows key's own key-up when a tap opens Start, so the key counts as let go once it is no longer
  physically down. The page is let go if it or its window goes away, another window of the app comes to the front, the
  window is minimized, or 5 s pass; if the Windows key is up and another program is still in front then, the page is
  asked to follow anyway, and the follow path gives it the keyboard when the window is activated again, as Windows
  gives it back to the last active window today. The page sees one blur and focus. The launch log counts the pages
  held and given back ("snap keys: … so far"). The launch check presses the five keys with the sidebar and with a page
  focused, quickly and with the Windows key held 300 ms around the arrow, presses Win+Left then Up in one press and
  compares it with the sidebar's, presses Win+V, Win+. and a Windows key tap from a page's text box, each dismissed
  with Escape, and checks after each where the keyboard is and that typing still reaches the box; a pop-up window's
  page must keep the keyboard, and the pop-up its place, through Win+Up. No clipboard or emoji panel opens on the CI
  runner, so the check proves that the text box keeps the keyboard, not that a panel inserts into it; the keyboard is
  back in the page at the key-up of V or the period, before a panel item is picked. Win+Shift+Left and Right need a
  second monitor and aren't checked.
- Find in page is the app's bar, as on the Mac. Ctrl+F in a page reaches the app's `findInPage` through `MenuKeyboard`'s
  thread keyboard hook, which sees keys meant for the page windows (the hosted windows have no Chromium shortcuts), so
  Chromium's own find bar never shows. React Native for Windows fires both `onKeyDown` and `onSubmitEditing` for one
  Enter in the find field, so the bar ignores a submit within 250 ms of the Enter it came from (`submitRepeatsKey`).
  `find_opens` and `find_steps` in the hourly `usage_counts` count it on every platform. The engine's `find` call still
  ignores `findNext` (#1425), so reopening the bar on the same words moves one match on.
- Peek opens as on the Mac. The engine host keeps a DevTools session of its own on each page and puts the Peek part of
  ArdiaCore's page script into an isolated world of every web frame (`page_links.cc`): the page can't see the script
  or its binding. It is registered for each new document (`Page.addScriptToEvaluateOnNewDocument` in that world, with
  the binding scoped to it), so it is in place before a page that just woke from sleep or came by a cross-process
  navigation takes input (engine `windows-engine-20261117-9`, #2198; the `engine links:` self-checks). A click on a link with the Peek key (`webView.setPeekModifier`), the Split key
  (`setSplitLinkModifier`), or a plain click to another site on a tab that peeks those (`setPeekOtherSiteTabs`), is
  cancelled and reported; the host checks it against the last real left mouse-up over that page and sends the Mac's
  `openWindow` (`peek` or `split`), or falls back as the Mac does. A tab the page opens itself carries `fromClick` only
  when the link script saw the user's own plain click on a `target=_blank` link to that address in the last two
  seconds, so a script's `window.open()` or `anchor.click()` never becomes a Peek, even during a user activation
  (ArdiaCore's page script also counts a `window.open()` during an activation; Windows doesn't).
  Cross-site iframes run in their own process and their own DevTools target, so links in them don't peek yet.
  The Peek card's background is a surface painted beneath the Peek's page, so a Peek's page (`temporary`) keeps a
  cover that encloses it whole; anything over part of it still cuts it. A Peek belongs to its tab (#1361): while
  another tab shows, its card stays mounted and unseen, its page is hidden, and `PageCoverGate` (a plain pass-through
  on the Mac) keeps the card's surfaces from cutting holes in the page that shows; back on its tab the Peek's page is
  asked to follow again (not seen on Windows yet). Escape closes a Peek from either page, as on
  the Mac: the host reports an Escape keydown the page didn't use as the `command` event `escape`, from any frame
  of the page (it watches every frame widget, so a cross-site iframe counts).
- A tab restored from the last session, or duplicated, loads its address: the Windows engine keeps no saved page
  state yet, so only tabs the engine itself offered are adopted.
- The Windows engine opens every tab on a real `about:blank` and names it as the committed page, where the Mac's tab
  starts on Chrome's initial document. `engine/pageEvents.ts` gives the UI the Mac's events: until a tab commits a
  page of its own, its `navigation` events say `committedInitial`, with no address and no title for that blank page,
  and a navigation that turns into a download reports no committed page. After such a download the engine still
  names the download's address as the visible one (a tab that opened on it) or `about:blank` (a tab that was already
  open), so a `navigation` event that says loading has ended then carries no address either, until the tab is asked
  to load something. So a download started from a new tab, the launch tab included, puts the tab back on the empty
  New Tab (or closes a tab a link opened) instead of leaving a blank page on the download's address, which the
  session then saved and downloaded again at every launch. A tab asked for `about:blank` by address keeps it, and a
  tab the engine opened itself keeps its blank page until a download.
  The engine reports these itself (`TabState::CommittedPageURL`): a download from a tab asked for `about:blank`
  names `about:blank` as its committed page, and one from a tab opened with no address names none. The `engine blank:`
  self-checks (`selfCheck/engineBlank.ts`, #2127) hold both against the engine as it ships.
- The engine's download list (`ac_downloads_list`) includes Chromium's history of earlier launches under their own
  ids, while the app restores its own list from `downloads.json`. Announcing the whole list at launch made each
  earlier download a new one: the panel opened by itself and listed it twice. The launch replay
  (`domains/downloads.ts`) announces only downloads still running or started since this launch, as the engine's live
  events do. The panel closes on a click in the page through `OutsidePressArea`, which page presses reach
  (`pagePress`); the full-window backdrop it also has only sees presses in the app's own surface.
- Chromium's own UI still shows where the app has none on Windows yet: the page's right-click menu, JavaScript
  dialogs and the status bubble for a hovered link. The right-click menu is Chromium's, as on the Mac, but the engine
  (`ardia/win/context_menu.cc`) leaves out what Windows can't do: Open link in split view, Cast, reading mode, listen
  to this page, the QR code, send to your devices, Lens, and opening a link as another Chromium profile; Save as
  shows no Ctrl+S, which is Ardia's Hide Tabs on Windows. Its search item still names Chromium's default engine.
- A tab or pop-up a page opens (`target=_blank`, `window.open`, with a size or not) never becomes a Chromium pop-up
  window and never shows in its opener's place: `Navigate()` (`chromium-win-hosted-popups-and-menus.patch`) asks the
  host, which inserts it as a background tab of the opener's hosted window (the opener stays the active, visible tab)
  and offers it to the app with `tab.opened` (`foreground` as the page asked, and for a pop-up `window: true` and
  `popup: {x, y, width, height}`, only what the page asked for). A blocked pop-up the user lets through opens as a tab,
  as before. The host tracks every offer until the app adopts or discards it; offers whose app window closes are
  closed with it. The app acknowledges each `tab.opened` it handled (`tab.offerHeard`, in `engine/host.ts`) and then
  owns the decision, so a background tab it keeps for later stays; an offer nobody acknowledged within 30 s (4 s in a
  test instance) is closed, whatever lost it.
- What a pop-up's page asks for goes to one place, `requestHost` (`engine/requestHosts.ts`): its opener's page while
  that page is listening and in the request's profile, else a browser page of that profile, else nobody. The profile
  test is `takerOfOpenedTab`'s: the same name, or for a private request a private page of the same original profile.
  An opener whose tab moved to another profile keys a new page in that profile while its pop-up stays in the old
  one, so the opener's page is passed over and the pop-up's tabs, links and app-link asks never cross profiles. A
  page's own offered tab takes the same test, for a tab that changed profile while the engine was opening one from
  it. With nobody, a tab or link the pop-up opens
  reaches the app whole, as the `tabs.windowRequest` engine event (the request with its offered tab, disposition and
  engine profile; the Mac never sends it). The app (`state/tabs/openFromWindowlessPage.ts`) gives it to the most
  recently focused browser window of that profile, with or without a page, through the same `openFromPage` a page's
  own request takes, or opens a window of that profile holding the tab when none is open. For a background tab that
  window opens without focus, behind the pop-up that asked (`opensBehind`, the native open's `behind`), so the pop-up
  keeps the keyboard. A background tab's offered page mounts its page view at once, hidden, which adopts it. It is never treated as a
  link from another app, so no external-link rule applies and it keeps its profile and live tab. A tab the app hasn't
  adopted within 10 s is closed in the engine, never left hidden and running; a profile the app doesn't know closes
  it at once. Known gap: a private pop-up's tab is closed and forgotten at once. The app makes a new private session
  for each private window and can't open one on an existing session, and a regular window would leak it. An app-link
  ask with nobody to show it is refused and forgotten (`externalAppForget`), where the Mac drops it unanswered: the
  prompt is drawn on the asking page's tab, so a window with no page has nowhere to show it.
- A pop-up window takes focus only if, when it opens, its opener's app window is the foreground window and the
  opener's page holds the keyboard (`keyboard.page`, asked by `WindowManager.h` at that moment, the same rule as page
  focus in #1658); a pop-up from a pop-up is placed and focused by that pop-up, while its tabs and prompts go to the
  main page. Otherwise it shows just above its opener's window and that window's pages, without activating, and never
  above another application's window. The Mac shows such a pop-up in front of its Ardia windows and makes it key
  within Ardia; Windows shows it in the same place but leaves the keyboard where it was.
  `host.info` counts Chromium pop-up windows in `popupBrowsers`, which the self-check expects to stay 0.
- Open pop-up windows as tabs (`webView.setPopupsOpenAsTabs`) is kept in the app, in `engine/popupsAsTabs.ts`: the Mac's
  native layer does it there, while on Windows the app makes the pop-up window itself. With it on, a `tab.opened`
  with `popup` goes to `requestHost` as the Mac's request (`foreground`, `popup: true`, the offered tab, the engine
  profile), so `openFromPage` puts it beside its page, keeps a Peek's page as a tab and counts it. The opener is the
  one the pop-up window would have used: for a pop-up from a pop-up, the first page. It stays a pop-up window when
  that opener is gone, when the opener or the page that would take it is in Little Ardia (the `small` window kind,
  noted as the app opens its windows in `modules.ts`, like the Mac's `ardia.window.small`), and when no page of its
  profile is listening. An extension's pop-up never comes this way: Chromium makes it as its own pop-up browser. The
  setting only decides for new pop-ups, so a pop-up window already open stays one.
- CI takes its engine from a GitHub release: `scripts/windows/engine/prebuilt.json` names the release and each
  CPU's zip with its SHA-256, `fetch-engine.ps1` downloads and checks it, and the Windows workflow assembles the app
  with it, launches it with the self-check (which then loads a page through the engine) and runs the tour's pages
  part. The release is a draft, so only the repository's own runs can fetch it; a fork's pull request skips those
  steps. A new engine build is a new release and a new `prebuilt.json`.
- A tab opened with no address shows a committed `about:blank` until its first load, which replaces that entry, so
  the first real page reports `canGoBack: false` and Back never leads to a blank page (the Mac's "ahead blank" rule).
  `downloadNavigation`'s `committedUrl` is the tab's last committed page, empty while it has only that opening page.
- `//ardia/win:probe` is a library that stands in for the app: a plain window that opens tabs, switches, navigates
  and asks the engine for history, bookmarks and the downloads folder, logging every reply and event. It also loads
  a page into a tab opened blank and goes Back, exports bookmarks to a Windows path, installs extensions from
  drive-letter and UNC paths that don't exist (the error must not be "an absolute path required"), asks for
  extension load health and a search suggestion, and with
  `ARDIA_PROBE_DOWNLOAD_URL` loads a download into a blank tab and a tab with a page. With `ARDIA_PROBE_COOKIE_URL`
  (a page that sets a cookie on `?set` and shows its cookies in its title) it sets a cookie in a normal and a private
  tab, opens a second private tab while the first is open, releases both and reads the cookie from a new private tab
  and a normal one; with `ARDIA_PROBE_SLOW_DOWNLOAD_URL` it ends a private session while a download in it is running.
  It proves an engine build with no app.
- Private windows work as on the Mac. Each private window has its own name (`incognito:<window>@<profile>`); every
  private window of a profile that is open at the same time shares that profile's one off-the-record profile, so
  they share cookies and sign-ins. `profiles.release` (the host verb `profile.release`, sent when a private window
  closes) drops the window's name, and when no name of that profile is left the session ends
  (`private_sessions.cc`). The host closes every Chromium window of that off-the-record profile with its warnings
  skipped, Chromium's `BrowserManagerService` hands the profile to `ProfileDestroyer` once its last window is
  destroyed, and in-flight work (renderers, downloads) ends with it. A private window opened while the old session is
  still ending waits until the old profile object itself is destroyed, not only told it will be (Chromium sends that
  before its renderers have gone), and then gets a new, empty one: the session's state is user data on the
  off-the-record profile, and its destructor resumes the waiting windows. If the old session still has windows 15 s
  after its last release, waiting windows and any later one of that profile are refused until it is gone. A released
  name never opens a tab again. `tabs.list` gives each tab's session number (0 for a normal profile), issued once per
  off-the-record profile object, and `host.info` the number of live sessions.
- A private window joins its session in the engine only when it opens a tab, and an app window's page windows are
  destroyed with it (Windows destroys owned windows before their owner), so a private window with no page yet (New Tab
  set to the command bar) kept nothing alive: closing the other private window destroyed the off-the-record profile's
  last Chromium window and with it the session. Each open private window now keeps the session itself: its
  `ArdiaWindowProfile` opens a hidden blank tab under the window's private name in its own page window while it is
  mounted (`holdPrivateSession` in `engine/privateWindows.ts`) and closes it when it goes. The Windows
  `profiles.release` also holds a private window's release while another private window of the same profile is
  open and sends the held ones with the last. The release of a session's last private window is lost in the shared
  window code (`privateSessions.ts` makes a nested store update when a session's last window closes, so
  `windowSync` sees the window already gone and never releases it), so a private window whose view has unmounted
  for a second also releases its name itself; each name is released once, and at quit every session ends with the
  process anyway.
- A page whose tab the engine refused (a private window opened while the old session would not end) stays in the
  app's list of pages; its next `loadUrl`, `reload` or `forceReload` asks for the tab once more and, when it opens,
  tells the page it is ready, or sends `loadError` when it is refused again (`engine/pages.ts`).
- Engine call arguments are wiped after the call: the engine keeps them in `ardia::Secret` (`api.cc`) and cleanses the
  copy it re-serializes for a private profile, and the app's `engineCall` keeps them in `WipedText`
  (`EngineHostModule.h`), which wipes its own buffer and every buffer it is moved from. This covers the copies the
  host and the app make, not every copy: the JavaScript string, React Native's own marshalling, Chromium's JSON
  reader, which keeps a decoded scratch copy of a string with escapes (a password with a backslash), and its
  serializer, which can free a smaller buffer while it grows, are not wiped.

## Calls Windows still answers with a stand-in

`forwarded.json` lists, per domain, the Mac's verbs that Windows has no handler for (`missing`). Each falls back to
`defaults.ts` or `null` and logs its name once. What each one needs:

- **Default**: the stand-in is the right answer on Windows, or the verb is a Mac test hook.
- **Native**: C++ in `apps/browser/windows`, no engine build.
- **Engine**: a new or changed `ac_*` call, host verb or `tab.call` method in a Windows engine build.

| Verb | Needs | What and why |
| --- | --- | --- |
| `autofill.settings`, `autofill.setSettings` | Engine | The Mac reads and writes the profile's `autofill.profile_enabled` and `autofill.credit_card_enabled` prefs; no `ac_*` call touches prefs. Today Settings › Autofill shows both toggles on and disabled. |
| `autofill.showSuggestions` | Engine | Shows Chromium's autofill popup in a tab: a `tab.call` method. |
| `contentBlocker.state`, `setEnabled`, `setListEnabled`, `isAllowed`, `setAllowed` | Engine | The Mac's blocker is uBlock Origin loaded as a component extension (`loadComponentExtension`, not an `ac_*` call) and driven through its hidden pages. Windows needs that load in the engine and the extension in the Windows package. Today Settings › Privacy shows no blocker. |
| `contentBlocker.devFailNextMessage`, `devDelayNextLoad` | Default | Mac test hooks. |
| `engine.beginTracing`, `endTracing`, `isTracing` | Engine | Chromium's tracing controller for Report a Problem. |
| `engine.cliTabTargets`, `cliOwnsTab`, `cliMoveOffscreen`, `cliCloseOffscreenTabs` | Default | The `ardia` command's control is off on Windows (the engine swaps its control file for a stand-in), so it opens no tabs to look up, take off-screen or close. |
| `extensions.resolveInstallPrompt` | Engine | Answers the Web Store's install prompt, which the engine doesn't send to the app on Windows yet. |
| `extensions.actionStates`, `extensions.sidePanelUrl` | Engine | An extension's toolbar state and side panel for a tab. |
| `media.displayMediaSources`, `screenRecordingAllowed`, `requestScreenRecording` | Engine | The app's own screen share picker; Chromium's picker shows today. |
| `media.selectDevice`, `cancelDeviceChooser`, `refreshDeviceChooser`, `openBluetoothSettings` | Engine | The Bluetooth, USB, serial and HID choosers drawn by the app; Chromium's own show today. |
| `media.showCastDialog`, `startCasting`, `stopCasting`, `closeCastDialog`, `watchCastRoutes`, `terminateCastRoute` | Engine | Casting. |
| `media.changeCaptureSource`, `media.stopCapture` | Engine | A tab's camera, microphone or screen capture. |
| `media.devShowBluetoothChooser`, `media.devChooserEvents` | Default | Mac test hooks. |
| `passwords.autofillEnabled`, `passwords.setAutofillEnabled` | Engine | The profile's `credentials_enable_service` pref, as for autofill. Today Settings › Passwords' offer-to-save toggle reads off and changes nothing. |
| `permissions.resolve` | Engine | Permission prompts drawn by the app; Chromium's own prompt shows today. |
| `permissions.devExternalLaunches` | Default | Mac test hook. |
| `profiles.loaded` | Engine | The profiles the engine has loaded, plus the `profiles.loaded` event. Today the call fails and the app counts every profile as open, as with lazy loading off. |
| Profile folder names (no verb) | App | The engine names a profile's folder `Ardia ` plus its id, with lowercase letters, digits and `-` kept and every other byte written `_` and two lowercase hex digits (`profiles.cc`), so each name has its own folder even on a case-insensitive disk and Ardia's own ids (`p-<base36>-<base36>`) keep the folder they always had. `profiles.deleteData` still maps only ids of that shape and refuses the rest; it could map the escape too. |
| `search.setEngineName` | Default | Names the search engine in the app's own page context menu; Windows shows Chromium's menu, which names Chromium's default engine. Needed again once the app draws that menu. |
| `tabs.routeLinkTabs`, `stripCommand`, `strips`, `reportCommits` | Default | The Mac's Chromium tab strip; Windows hosts pages only, so the empty answers are right. |
| `tabs.dev*` (10 verbs) | Default | Mac test hooks. |
| `webView.setDisplayMediaPicker`, `setSelectionPopover`, `setCommandScrollZoom`, `setLittleArdiaOpensNewTabLinks`, `setAutoPictureInPicture` | Engine | Settings for the page script and the Mac's page input hooks, which Windows doesn't have yet. |
| `webView.setVideoUpscaling`, `setVideoUpscalingTestConditions`, `videoUpscalingState` | Native and engine | The Mac upscales with MetalFX; Windows needs a Direct3D path. |
| `windows.list`, `windows.dev` | Default | The Mac's Chromium window hosts. |

`search.suggest`, `search.stopSuggest` and `extensions.loadHealth` are forwarded to the engine
(`ac_search_suggest`, `ac_search_suggest_stop`, `ac_extensions_load_health`) since `windows-engine-20261112-2`. When the
Mac forwards a call the shipped Windows engine lacks, `forwarded.json` lists it under `awaitingEngine` and Windows
answers it in TypeScript until a new engine build has it; none waits now.

Not in `forwarded.json` but also engine work: media next and previous track. The media controls send `mediaCommand`
`next` or `previous` (`state/media/media.ts`), the Windows view passes it on as `tab.call`, and `MediaCommand` in
`tab_calls.cc` runs a page script that has no case for either, so nothing happens. The Mac calls the page's own
`nexttrack` and `previoustrack` handlers through its page script. The engine needs to call
`content::MediaSession::Get(contents)->NextTrack()` and `PreviousTrack()` there, and to send a `nowPlaying` tab event
(title, artist, album, artwork, playback state, position, duration, rate, video or not, and the actions the page set
handlers for, from a `MediaSessionObserver`): Windows sends only `media` (audible, muted), so the app never builds a
session with track actions, and the mini player shows skip by 15 seconds where the Mac shows the track buttons.

Answered in TypeScript on Windows since this list was made: `engine.info` (from `host.info`), `favicons.fetch` (the
icon Chromium stored for that address, from `ac_favicons_get`, asked again after 0.4 and 1.5 s while Chromium writes
it), and `profiles.deleteData`.

Answered on Windows since the engine took Windows paths (`windows-engine-20261112-2`), in `domains/exports.ts`,
`unpacked.ts` and `systemState.ts`, with the dialogs, file reads and power reading passed in as the domain engine's
`desktop` (`domains/desktop.ts`):

- Links to other apps: `chromium-win-external-protocol-dialog.patch` gives Chromium's `ExternalProtocolHandler` the
  hook the Mac's `apply.sh` adds (`g_ardia_win_external_protocol_dialog`, called after Chromium's own block state and
  denied schemes, with the request's user gesture). For a tab the host keeps, `ardia/win/external_apps.cc` sends the
  `externalApp` tab event (`id`, `url`, `origin` or null, `userGesture`, `offTheRecord`) to `domains/externalApps.ts`
  and keeps the asking document. The `externalAppAlive` page call answers `{ alive: true }` once per request while
  that document is the one showing: still there, active (not kept in the back/forward cache, not pending deletion
  after a navigation) and in the tab's primary page. The Mac's `ResolveExternalApp` checks only that the document
  still exists. Every request with an initiating origin that isn't an
  extension's counts as a page's, opaque origins included: a `data:` page or a sandboxed frame needs its document
  alive too. Only a request with no initiating origin (the browser) or an extension's needs just its tab. The prompt
  shows an origin only when it isn't opaque; otherwise it says "This page wants to open this application." and never
  borrows another page's name. A cross-site navigation drops the page's prompt (`state/tabs/pageEvents.ts`
  `leftPage`, as on the Mac); after a same-site navigation or a reload the prompt can stay, and Open then launches
  nothing because the asking document is no longer the one showing, even while the back/forward cache keeps it. The engine keeps a page's 8 newest asks at most, and the app tells it
  (`externalAppForget`) whenever it drops one without launching: a no, no handler, a closed page or a forgotten
  profile. `mailto` never asks: Chromium allows it by default and opens the mail app itself,
  as on the Mac.
  - **Describe:** `ArdiaExternalApps.describe` names the scheme's handler and draws its icon (`AssocQueryStringW` with
    `ASSOCSTR_FRIENDLYAPPNAME` and `ASSOCSTR_EXECUTABLE`, then `SystemShell::FileIcon`). A classic scheme under
    `Software\Classes` (how Zoom and Slack register) gets no name from `AssocQueryString` on Windows 11 build 26200,
    so, like Chromium's `GetAppForSchemeUsingRegistry`, it then takes the scheme's own name (without `URL:`) or the
    program of its `shell\open\command`. A packaged handler (the new Outlook for `mailto`) has a name but no
    executable, so its prompt shows no icon. Like Chromium, it knows only
    schemes whose `HKCR` key carries `URL Protocol`, so a file type's ProgID can't pose as a link scheme, and it
    refuses one-letter schemes (drive letters).
  - **Prompt:** the Mac's prompt shows in the Mac's words. Like every page prompt it ignores input for half a second
    after it appears and after an Ardia window becomes active; the window becoming active again because the user
    clicked from one of its own page windows back into it doesn't count (`WindowManager.h` marks that `focus` event
    `fromPage`, and `state/site/promptGuard.ts` skips it), so the first click on the prompt works. "Always allow" is offered only for an https or loopback
    site, outside private windows, and kept per profile in `external-app-allowances.json`; deleting a profile
    forgets them. A remembered site opens the app without asking only when the request had a user gesture.
  - **Lifetime:** an ask belongs to its page and is dropped when the page closes. Before any launch the engine must
    answer `true` to the `externalAppAlive` page call, which needs the asking document to be the active one in the
    tab's primary page, so a prompt survives a single-page site's route change but opens nothing once its document
    is no longer shown, cached or not.
    The prompt carries an id the app makes, so two pages whose engine ids collide never answer each other's
    prompt. The engine's origin must be a serialized origin (no user info, path or spaces), and a profile deleted
    while a yes waits for the engine keeps no allowance and opens nothing.
  - **Counts:** the prompt's buttons are counted in the app (`externalAppCounts.ts`: `external_app_allows`,
    `external_app_allows_always`, `external_app_declines`), on the Mac too. Only Windows knows whether a launch
    happened, so `ArdiaExternalAppCounts.takeLaunches` adds `external_app_launches`, `external_app_launches_refused`
    (allowed, but the page had gone, the profile was deleted or the handler changed) and
    `external_app_launches_automatic`; the Mac sends 0 for those three. Watch refused against launches.
  - **Open:** `ArdiaExternalApps.open` opens only the asked URL of a pending request. It never opens http, https or
    file. It escapes the URL as Chromium's `EscapeExternalHandlerValue` does, and hands it to `ShellExecuteExW` as
    the single `lpFile`, with the system folder as the working folder as Chromium does. It takes the handler's
    name and executable from the prompt and opens nothing if the scheme's handler changed since.
  - **Denied schemes** stay Chromium's own (`ExternalProtocolHandler`), which run before the engine's hook, as on
    the Mac.
  - **Self-check** (`selfCheck/externalApps.ts`): `describe` names no handler and `open` opens nothing for browser,
    one-letter, path, file-type (`txtfile`) and unknown schemes. It launches nothing unless the test instance sets
    `ARDIA_TEST=externalAppLaunch=1` (read from the launch config, so only in a test instance, see Test instances;
    it lifts only the background instance's refusal to launch): then each link in the data folder's `external-app-links.txt` goes through the
    real gate and launch, which must name a handler, open nothing on no and open on yes (a line starting `! ` must
    stay refused). The VM run uses that with a throwaway handler registered under `HKCU`.
- `bookmarks.exportHtml` and `passwords.export`: `ArdiaDialogs.saveFile` (a Windows save panel, `SaveDialog.h`; the
  password one carries the Mac's warning that anyone who can open the file can read the passwords), then
  `ac_bookmarks_export_html` or `ac_passwords_export`, which asks Windows to confirm it is you before it writes
  (`reauthFailed` otherwise). A background instance answers the panel from `file-chooser.txt` and logs that a file was
  chosen, never which.
  Windows confirms the password export with Windows Hello, or with the Windows Security password prompt when Hello
  isn't set up. Chromium shows that over `GetLastActiveBrowser()`'s window, which in Ardia is a page window, so
  `chromium-win-reauth-app-window.patch` gives it a hook and the engine host answers with the app window the user is
  in. In Chrome that password prompt is modal on the browser UI thread, so other engine calls
  and quitting wait on it (the old stall, when the prompt sat unseen on a page window); the patch runs it on a pool
  thread that shutdown doesn't wait for. Every confirmation has a 110 s deadline, under the app's two-minute
  timeout: at the deadline the export answers `reauthFailed`, the password prompt is closed, and a later answer is
  dropped, so nothing is written after the app gave up. If either export has not answered
  after `EXPORT_ANSWER_MS` (two minutes, enough for a large profile), it fails the way the Mac's does: the bookmark
  export reports "Couldn't export" and the password export answers `writeFailed`.
- `extensions.chooseFolder` and `extensions.inspectUnpacked`: `ArdiaDialogs.pickFolder`, then the Mac's
  `ReadManifest` in TypeScript over `ArdiaWindowsImport`'s file reads: the manifest (comments and trailing commas
  allowed, as Chrome does), its `_locales` messages (locale names only), the icons as data addresses, and the id from `key`.
  Every read goes through `readTextWithin`/`readBase64Within`, which compare the opened file's real path with the
  folder's, so no `..`, junction or symlink reaches outside it; the size limit is the opened file's, not a link's. `install` and `installCrx` already went to `ac_extensions_install` and `ac_extensions_install_crx`.
- `engine.systemState`: `ArdiaSystemSignals.powerState` (`GetSystemPowerStatus`, `GlobalMemoryStatusEx`) mapped onto
  the Mac's shape: on battery, the battery's level, battery saver as `lowPowerMode`, and memory pressure from the
  memory load (warning at 85%, critical at 95%). It is read again every 20 s and `engine.systemState` is sent when it
  changes, as macOS's notifications do. Settings › Advanced says "battery saver" where the Mac says Low Power Mode.

Deleting a profile's data: native (`ArdiaEngineHost.removeProfileFolder`) works out Chromium's data folder itself, as
the engine does (`<ARDIA_DATA_DIR>\Chromium` in an instance with its own data folder, `%LOCALAPPDATA%\Ardia\User Data`
otherwise), and acts only where that folder holds the `Default` profile folder or `Local State` and agrees with `host.info`'s
`userDataDir`. The folder counts first: Chromium saves `Local State` with `ReplaceFile`, and while it does a reader can
find the file missing, which made a removal answer "refused" and leave a deleted profile's data on disk (#2120). A profile
is deleted by its folder only when its id is one Ardia makes: lowercase `a-z`, `0-9` and `-`, at most 238 characters,
so that `Ardia <id> (removing)` fits one 255-character NTFS name. Its folder is then exactly `Ardia <id>`. Any other id
(hand-edited state, a sync from something else, a bug) could share its folder with another profile, so on purpose
nothing is renamed, removed or cleared for it: the answer says the id isn't one Ardia makes, its data stays, and the
app logs that it couldn't delete it. A name with `@` is a private session to the engine and has no folder; a name with
a NUL is refused, since the engine reads it only up to the NUL. Native renames the folder to `<folder> (removing)` first,
which fails while the engine holds a file in it, so a loaded profile's folder is never half removed: its browsing data
is cleared through `ac_browsing_data_clear` instead and the folder goes at the next launch. A `(removing)` folder left by
an earlier try is cleared first, and while it stays the answer is that files are left, never that the folder is gone.
The original profile's folder is never removed: as on the Mac (`ProfileData.swift`), its browsing data, form data and
site settings, passwords and never-save sites, addresses, cards, running extensions, site settings and zoom levels are
cleared one by one through their `ac_*` calls, and each step that fails is named. The launch log says
`profile folder removed|in use|partly removed: <folder>`.

## Import from another browser

The Mac's `ArdiaImport` (Swift, `packages/import`) has a Windows version in TypeScript, `packages/expo-windows/src/import`,
that answers the same methods with the same result shapes, so the wizard (`components/import`) and
`state/import/apply.ts` are the Mac's. Only the OS calls and the secrets are native: `ArdiaWindowsImport` (`ImportModule.h`,
`ImportFiles.h`, `ImportSecrets.h`, `ImportNss.h`, `ImportFirefox.h`, `ImportFirefoxCookies.h`, `ImportAutofill.h`).

- Native primitives: the two data folders (`localAppData`, `roamingAppData`, or `<importSourceDir>\Local` and `\Roaming`
  when `ARDIA_INSTANCE=importSourceDir=<dir>` is set in a test instance), `list` a folder,
  `readText` and `readBase64` a file up to a size, and `query` a SQLite file: it is copied with its `-wal` and
  `-journal` to `%TEMP%\ardia-import-<pid>-<random>` (leftovers over an hour old go at the next launch), opened with
  Windows' own `winsqlite3.dll` with ATTACH off, and only statements SQLite calls read-only run. The browsers' secret
  stores (`Cookies`, `cookies.sqlite`, `Login Data`, `Web Data`, `key4.db`, `logins.db`, `logins.json` and their
  `-wal`/`-journal`) are refused to these generic reads under any name Windows resolves to them (any case, a trailing
  dot or space, a stream suffix, a short name: the check also reads the opened file's real name), so their plain-text
  values can't reach JS through them. A sidecar that exists but can't be copied fails the snapshot rather than leaving
  it without the latest writes, and a copy during which the database or its WAL changed (a checkpoint, a write) is
  taken again, up to three times, then reported as in use. `openSnapshot`, `querySnapshot` and `closeSnapshot` keep one snapshot open across
  calls (closed after 10 idle minutes otherwise), so history is read 5,000 rows a page instead of in one reply. A file the browser holds open with no
  sharing (Chrome does this to `Network\Cookies` and others while it runs) answers `inUse`, and that kind fails with
  "Quit <browser> and import again".
- Discovery (`browsers.ts`, `discovery.ts`): Chrome, Edge, Arc, Firefox, Zen, Brave, Vivaldi, Opera, Opera GX, Chromium,
  and the Beta, Dev and Canary (`SxS`) channels of Chrome and Edge and Brave's Beta and Nightly, each from its own folder
  under `%LOCALAPPDATA%` or `%APPDATA%` (Arc from its package's `LocalCache`). Chromium profiles come from `Local State`
  and the `Default` and `Profile *` folders; Firefox and Zen profiles from `profiles.ini` (relative paths only).
- What is read, per profile, with the Mac's readers ported: bookmarks (`Bookmarks`, `AccountBookmarks`; Firefox
  `places.sqlite`), history (`History`; `places.sqlite`), open tabs (the newest cleartext `Sessions\Session_*` or
  `Current Session`; Firefox and Zen `sessionstore-backups\recovery.jsonlz4` and the rest, LZ4 in TypeScript), favicons
  for the imported tabs and bookmarks bar (`Favicons`; Firefox and Zen `favicons.sqlite` in `firefoxFavicons.ts`, with
  `FirefoxFavicons.swift`'s rules: PNGs up to 64 px by their own header, SVGs and other formats skipped), a bookmarks HTML file and a passwords CSV file (picked with
  `ArdiaDialogs.pickFiles`).
- Spaces (`arcSidebar.ts`, `zenSession.ts`, `zenSidebar.ts`, `sidebars.ts`, ported from `ArcSidebar.swift` and
  `ZenSidebar.swift`): Arc for Windows keeps `StorableSidebar.json` beside its `User Data`, in
  `%LOCALAPPDATA%\Packages\TheBrowserCompany.Arc_ttt1ap7aakyb4\LocalCache\Local\Arc`, in the Mac's format (the path
  and the format are what the open-source exporters read, e.g. ivnvxd/arc-export, which parses both platforms' files with
  the same code). Its spaces, pinned tabs, today tabs and favourites (Top Apps) come over per Chromium profile. Zen's
  workspaces, folders, pinned tabs and Essentials come from `zen-sessions.jsonlz4` in the profile folder, then
  `zen-sessions-backup\`, then the Firefox session store and `places.sqlite` `zen_workspaces`, as on the Mac; the source
  carries `sidebar: "arc"` or `"zen"`, so the wizard offers spaces.
- Passwords and cookies (Chromium family): the key is `os_crypt.encrypted_key` in `Local State`, unwrapped with DPAPI
  (`CryptUnprotectData`, no prompt: it is the same Windows user), and values are `v10` AES-256-GCM through BCrypt; a value
  with no prefix is tried as plain DPAPI (Chrome before 80). Chrome's app-bound values (`v20`, `app_bound_encrypted_key`)
  need Chrome's elevated service to unwrap, so they are counted and skipped, and the kind warns "N passwords use Google
  Chrome's app-bound encryption, which only Google Chrome can read" (an `undecryptable` warning, as the Mac's). So the
  wizard has no unlock step on Windows (`needsKeychain` is false), and the key is unwrapped the first time a kind needs it.
- Firefox and Zen passwords: `ImportNss.h` derives the `key4.db` key with BCrypt (PBES2: PBKDF2-SHA256 and AES-256-CBC;
  older profiles: the SHA-1 and 3DES PBE) with the empty primary password, as the Mac's wizard does; a profile with a
  primary password set fails the kind with the Mac's locked "Wrong Firefox primary password". `ImportFirefox.h` decrypts
  `logins.json` (3DES or AES-CBC fields) and `logins.db` (JWE, AES-256-GCM under the `as-logins-key` key) and merges
  them as `FirefoxLogins.swift` does. Firefox and Zen cookies (`ImportFirefoxCookies.h`, `cookies.sqlite`) skip container
  and private-window cookies and say how many ("N cookies from containers or private windows weren't imported").
- Autofill (Chromium family, `ImportAutofill.h`): `Web Data` addresses (the token tables and the older
  `autofill_profiles`) and cards (`v10`, or plain DPAPI; `v20` is app-bound and counted), as `ChromiumAutofill.swift`
  reads them. A card the key can't open without `Local State` is counted as locked.
- Secrets: the key stays native and is wiped by `forgetUnlockedKeys`. Passwords reach JS (`credentials`), as on the Mac,
  because `savePassword` (`ac_passwords_add`) takes them from there. Cookie values and autofill entries never do: native
  decrypts them straight into wiped buffers already in `ac_cookies_import`'s and `ac_autofill_import`'s JSON, batches of
  500, keeps them for 10 minutes under one one-time token per import (the autofill joins the cookies' entry), and JS gets
  the counts and the token. `writeImported(token, profile, kinds)` sends the cookie batches and then the autofill
  batches to the engine one after another, wipes each after its reply, and wipes the kinds the wizard didn't ask for. A token is dropped after 10 minutes even if nothing asks again, and a vault
  `forgetUnlockedKeys` cleared while a read was running stays empty.
- Not on Windows yet, each offered by no profile so the wizard doesn't show it: Chromium's encrypted session files
  (`Sessions_Encrypted`), extensions found in the profile, Safari, Dia's tabs.
- Tests: `apps/browser/src/state/import/windowsImport.test.mjs`, `windowsSidebars.test.mjs` and `windowsAutofill.test.mjs`
  run the TypeScript against `packages/import/fixtures` with a stand-in for the native module
  (`state/import/fixtures/windowsHost.mjs`: Node's own `node:sqlite`, the same snapshot copy). The self-check's import area
  exercises every native method in the app; `launch-smoke.ps1` copies the fixtures' Firefox, Zen and Chrome profiles
  into the self-check's data folder (`import-fixtures`), so the NSS, `logins.db`, cookie and `Web Data` readers decrypt
  real files there. Telemetry: `import_runs`, `import_kinds_done`, `import_kinds_failed` and
  `import_secrets_left` in the hourly `usage_counts` (`state/telemetry/importRuns.ts`, every platform): a rising share of
  failed kinds or secrets left on Windows is the sign to look at.

## Sync

Windows syncs with Macs through the same folder and the same vault: `folder\<chain tag>\<scope tag>\<file id>.nns`,
sealed exactly as `packages/sync/ios/Core/SyncCrypto.swift` seals it. The engine (`state/sync`) is the Mac's;
`ArdiaSync` is answered by `packages/expo-windows/src/sync` (layout, listing, QR code, Recovery Kit) over the native
`ArdiaWindowsSync` (`SyncModule.h` and the `Sync*.h` headers next to it), which keeps every secret out of JS:

- Keys: the 24 words are made and read natively (`SyncPhrase.h`, the Mac's wordlist in `SyncWordlist.h`), the entropy
  is sealed with DPAPI for the current user into `<data folder>\Sync\sync-key-<device id>.dpapi` and wiped after the
  four keys are derived (BCrypt HKDF, HMAC and AES-256-GCM in `SyncCrypto.h`). A failed unseal never makes a new key;
  sync asks for the phrase. Each operation holds the keys it started with; `forget` bumps a generation, so a result or
  an owner check that began before it is dropped.
- Passwords are off on Windows (`PLATFORM_FEATURES.syncsPasswords`: no What Syncs row, the type never syncs, and
  the Mac's synced passwords stay in the vault untouched). Chromium turns `kSkipUndecryptablePasswords` on by default
  on Windows only, and Ardia keeps it on: Settings, export and autofill read through the affiliation path, which still
  leaves out a login it can't decrypt. The plain login read is strict on Windows (`chromium-win-strict-login-list.patch`):
  it fails when any login can't be decrypted, for every caller of that read, so no caller has to remember a flag.
  Chromium never deletes a login it can't decrypt on Windows (`chromium-win-keep-every-login.patch`):
  `LoginDatabase::DeleteUndecryptableLogins`, the only code that does, deletes nothing, so neither
  `kClearUndecryptablePasswords` nor `kClearUndecryptablePasswordsOnSync` can turn it on. That rule is proven from the
  source, not exercised: a test instance's `--user-data-dir` already skips Chromium's cleanup.
  `ac_passwords_logins` answers the full list (empty means no passwords), "undecryptable" or "unreadable"; "closed"
  and "no password store" mean the profile isn't ready. Sites never to save and federated sign-ins have no password
  and are left out. An ordinary login whose stored password is empty is listed with `"passwordless": true` and no
  password: Chromium stores such logins (an imported one with an empty password, a username-only one), and on disk
  they look the same as a damaged blob, so the engine lists them and Sync decides. The native side passes it on
  unsealed (`SyncLogins::SealedLogins`), and Sync's password adapter neither uploads it nor reads it as a deletion
  (`ignore`), and never writes a synced password over it: such a login stays as it is on this machine and nothing about
  it is uploaded, and a damaged row is the user's to fix by saving the password again. Before passwords sync on
  Windows (#1425), Sync must treat every error as "skip this cycle, delete nothing". The Mac drops such a login
  silently (#1933).
- Passwords, once the engine lists them: `ac_passwords_logins` is called and its reply sealed in C++ (`SyncSystem.h`),
  and a synced password is opened only to hand it to `ac_passwords_add`. The Mac's vault files carry plaintext `p` in `pw:` records, as the Mac
  writes them; `SyncLogins.h` swaps them for sealed `s` before JS sees a document (escaped keys included; a login it
  can't seal loses its `p`) and back when writing. Replacing a password reads the old one first and puts it back if
  the add fails, because `ac_passwords_update` asks the user to sign in again.
- Disclosure (Show Words, Copy Words, Show Code, the Recovery Kit): Windows Hello, else Windows' own password prompt
  checked with `LogonUser` against this user's SID, valid for 60 seconds as on the Mac. A hidden test instance answers
  from `ARDIA_TEST=reauth=granted`. Copied words are kept out of clipboard history and the cloud clipboard.
- Files: written to a hidden staging file, flushed, then moved into place without replacing; read only when the size
  and write time didn't change during the read. OneDrive's online-only files are never opened: they wait as pending
  while a single background reader downloads them (one try per file a minute, at most 64 queued). A file another
  program is writing waits too. Links where the vault's own folders belong are refused, and deleting the vault never
  follows one. Like the Mac, sync polls every 15 seconds; it does not watch the folder.
- The Recovery Kit is drawn in TypeScript (`kit.ts`, `pdf.ts`), with a QR code module for module CoreImage's
  (`qr.ts`, `windows-interop/qr.txt`); the preview is the kit with masked words, rendered by `Windows.Data.Pdf`.

Proof that the formats agree: `packages/sync/tests/WindowsInteropTests.swift` opens a vault written through the
Windows code path (`fixtures/windows-interop/windows`), `state/sync/windowsVault.test.mjs` reads the vault the Mac's
Swift core wrote (`fixtures/windows-interop/mac`), and the self-check opens that same Mac vault with the native code.

## Updates

- The updates live on the GitHub prerelease `windows-alpha`: `Ardia-Setup-x64.exe`, `Ardia-Setup-arm64.exe`, the
  feed `windows-update.json` (version, build, and per CPU the installer's address, SHA-256 and size) and the
  engine's source. `scripts/windows/publish-alpha.sh` puts one build there, the feed last. It keeps the installers of
  the build before, so an update the app already offered still downloads, and removes older ones. It refuses a build
  at or below the live feed's, since no installed app would take it.
- Every release refreshes it (Releases, below), so installed Windows apps update to each nightly and stable.
  `publish-alpha.sh <run id>` still publishes one green Windows workflow run there as an alpha between releases.
- A build knows what it is from `Ardia.build.json` beside `Ardia.exe` (`assemble.ps1 -Version -Build`). The build
  number is the number of commits in the built commit's history (`git rev-list --count`, the workflow's `identity`
  job), so it grows with `main` and a release outranks every build before it, CI's included; builds before this rule
  were numbered by the run (up to about 670). The Windows workflow puts the same file beside the installer in its
  `Ardia-Setup-<cpu>` artifact, which is where `publish-alpha.sh` reads a build's version and number. `ArdiaApp.systemInfo` takes its version and build from that file, since the library has no version
  resource, so telemetry, About and problem reports name the build; a folder build without it says 0.0.0, build 0. Only an installed build with that file updates: Settings › General › Updates shows "not set up" for a
  folder build.
- `packages/expo-windows/src/updater` is the app's `ArdiaUpdater` on Windows. It reads the feed, offers a higher
  build for this CPU, downloads it, and asks before installing; with automatic downloads on it downloads first and
  asks once. It checks 30 s after launch and every 6 hours, never in a hidden instance, and in an instance with its
  own data folder only when a test instance names a feed with `ARDIA_INSTANCE=updateFeed=<url>` (then installers must
  sit beside it).
- The native half (`UpdateModule.h`, `ArdiaWindowsUpdate`) only fetches from the release's address, checks the
  download's size and SHA-256 against the feed, and runs the installer from the Updates folder in the data folder
  after hashing it again while holding it open. The installer runs silently, closes what is left of the app and
  opens it again (`/relaunch=1`). Nothing is signed yet, so what stands behind an update is GitHub's HTTPS and the
  release's write access.

## Releases

The Release workflow (`.github/workflows/release.yml`, dispatched by the `release` skill) builds Windows next to the
Mac, for every nightly and stable:

1. Its `windows` job calls `windows.yml` with the release's version, at the release's commit: the same build, pinned
   engine (`scripts/windows/engine/prebuilt.json`), launch, tour and installer checks as CI, for x64 and arm64.
   `release-files.ps1` names each tested installer `Ardia-<version>-windows-<cpu>-setup.exe` with its `.sha256`, and
   the job leaves them with `Ardia.build.json` in the artifacts `windows-release-x64` and `windows-release-arm64`. Its
   `source` job packs the engine's source, `Ardia-<version>-windows-source.tar.xz` with a `.sha256`, in
   `windows-release-source`: `scripts/windows/engine-source.sh`, from the Helium tags `helium-pins.ini` pins at that
   commit, with a README naming Chromium's source and this repository's tree.
2. `publish` attaches both installers, the engine's source and their `.sha256` files to `v<version>` (`publish.sh`
   checks the hashes and that the build is this version, and refuses installers without their source), so every
   release keeps the source beside its Windows binaries for as long as it stays up. A dry run checks the same and
   attaches nothing.
3. `windows-update`, after `publish`, runs `publish-alpha.sh --installers` on those files: a real run puts them on
   `windows-alpha`, with the same source archive as `ardia-windows-source-<build>.tar.xz`, and points the feed at them,
   so installed Windows apps offer the release; a dry run packs the feed and prints what it would upload.
   `publish-alpha.sh <run id>` packs the source with the same `engine-source.sh`.

A Windows failure never holds back the Mac release: `publish` warns that Windows was skipped, and the release ships
without the installers and without refreshing the feed. Don't re-run the Release run's failed jobs for it: that runs
`publish` again, which can't create a release that exists. When the cause is outside the code (a runner, a flaky
check, an engine release the token can't read), build the release's commit on its own and add the result:

```bash
gh workflow run windows.yml -R ardia-browser/ardia --ref v<version> -f version=<version>
gh run download <run id> -R ardia-browser/ardia -p 'windows-release-*' -D dist/<version>/artifacts
mkdir -p dist/<version>/windows && cp -n dist/<version>/artifacts/windows-release-*/* dist/<version>/windows/
gh release upload v<version> -R ardia-browser/ardia dist/<version>/windows/Ardia-<version>-windows-*
scripts/windows/publish-alpha.sh --installers dist/<version>/windows --commit v<version>
```

When the cause is in the code (a stale engine pin needs a new engine release and `prebuilt.json`), fix it on `main`;
Windows skips this version and ships with the next release. When only `windows-update` failed, the installers are on
the release already: re-run that job alone (its re-run touches nothing else), or run the last line above on its
`windows-release-*` artifacts, flattened into one folder as above.

## Test instances

`LaunchConfig.h` (`AppLaunch::Shared()`) reads the environment once at launch; `Paths.h` holds the one raw reader and
the data folder. Whether this launch is a test instance is decided once, by the engine, before the app loads
(`scripts/windows/engine/src/ardia/win/test_gate.cc`), and handed to the app through `EngineApi.h`'s
`testGateRefusal()`, so the two can't disagree when the marker or a folder changes in between. `TestGate.h` holds the
same rule for the app run without the engine (`ArdiaAppRun`). No other Windows native file reads
the environment (`platform/windowsLaunchConfig.test.mjs` fails if one does). The one exception is the small
`ArdiaLauncher`, which runs before the DLL loads and reads `ARDIA_BACKGROUND` only to keep a failed launch quiet.

A test instance needs all of:

- an absolute `ARDIA_DATA_DIR` (not `C:foo` or `\foo`);
- that folder and its `Chromium` folder, compared by their final paths on a local volume (junctions, `subst` drives and
  8.3 names resolved), are not, inside or around the real `%LOCALAPPDATA%\Ardia` or `%APPDATA%\Ardia`;
- a test build: an `Ardia.test-build` file beside `Ardia.exe`.

Windows builds are not signed yet, and the alpha publishes the exact installer CI built and tested, so no build flag
can tell a published build from a tested one. The marker does instead: `launch-smoke.ps1` and `tour.ps1` write it
beside the app they run, `assemble.ps1` never copies it, `make-installer.ps1` refuses a folder that holds it and
`installer-check.ps1` fails when an install carries it. So a build installed from the alpha, or updated to by the
app, ignores test keys. A VM script that tests an installed build with test keys writes the marker into the install
folder first. That folder is the user's to write, like the Mac's app bundle: anyone who can drop the marker can also
replace `ArdiaApp.dll`, and on the Mac a changed bundle is likewise no longer signed for distribution.

What it guards: the unmodified build people install can't be switched into test behaviour by the environment alone,
and a test instance never runs on the real profile folders by mistake. What it doesn't: code already running as the
user, which can plant the marker, race the folder check with a junction, or hard-link a scratch file to a real one.
That code can also decrypt the real profile's DPAPI secrets directly, without Ardia; the Mac's keychain ties its items
to the signed app, and Windows has nothing like it until builds are signed or installed per machine. `ARDIA_CONFIG_DIR`
gets the same folder check, and a folder that can't be resolved on a local volume doesn't count.

Secrets stay apart the way the Mac's mock keychain keeps them: Credential Manager targets are named after the data
folder, Chromium's key sits in the data folder's `Local State`, and the Sync key (`SyncSecrets.h`) lives in
`<data folder>\Sync`, which the folder check covers too, sealed by DPAPI under a purpose a test instance never shares
(`ardia-sync-key/v1/test-instance/<account>`). A real key copied or hard-linked into a test instance doesn't unseal
there, and one sealed in a test instance can't stand in for the real one. `reauth=granted` skips Windows Hello only
for that test key. A test key sealed by a build before this rule doesn't unseal any more and counts as no key, so
the scratch instance makes a new one. Sync's `selfTest`, which seals and removes a probe key, needs a test instance.

Outside a test instance the launch config drops `ARDIA_TEST`, `ARDIA_TRACE`, `ARDIA_CONFIG_DIR` and the test-only
`ARDIA_INSTANCE` keys (`updateFeed`, `importSourceDir`, `importSafariHome`), and the launch log says once why. The other
`ARDIA_INSTANCE` keys and `ARDIA_BACKGROUND` stay instance settings, as on the Mac.

The engine applies the same decision to its own switches (`main.cc` `DecideTestGate`, before Chromium starts):

- **Which process.** A launch counts as the browser process when its `--type` is missing or empty, as Chromium counts
  it, so an empty `--type=` can't skip the gate.
- **Which folder.** The gate judges the profile folder Chromium will really open: `install_static::GetUserDataDirectory()`,
  which `chrome_elf` derives from the raw command line, policy and `ARDIA_DATA_DIR`. It must be `<ARDIA_DATA_DIR>\Chromium`,
  compared by final path, so a `--user-data-dir` or a policy pointing anywhere else refuses the test instance. The
  path string Chromium will open must also be the held folder's own path (its final path as a drive path), so an alias
  that merely resolves to it (a junction, a short name, a mapped drive) is refused: an alias could be re-pointed after
  the check.
- **What a test instance gets.** `--remote-debugging-port` (with `remote-allow-origins=*`), `--ardia-test`,
  `--ardia-trace` and `--ardia-test-instance`, which `ardiacore`'s gate reads in place of the Mac's signing check
  (`series_win.py` `launch_switches_source()`). Those switches given on the command line are always dropped first.
- **What everyone else loses.** Outside a test instance the engine drops the Mac's list of switches that open the
  profile to an outsider (`--load-extension`, `--disable-web-security`, `--enable-automation`, the remote debugging and
  proxy switches and the rest of `kSwitchesThatOpenTheProfile`), plus five Windows-only ones that start a chosen
  program as a browser child or run children unsandboxed (`--browser-subprocess-path`, `--renderer-cmd-prefix`,
  `--utility-cmd-prefix`, `--gpu-launcher`, `--no-sandbox`; nothing in the engine, CI or the probe passes them), and
  unsets `SSLKEYLOGFILE`; if that variable can't be cleared the engine doesn't start. This happens before Chromium starts and
  again after `chrome://flags` adds its switches. A second launch handed to the running instance only gives it its URLs
  (`Relaunched`), and child processes only get switches the browser process still has. The launch log gets one
  `engine 0 test gate:` line saying why, and `reauth=granted`, `keychain`, `safeStorageAnswer` and the other engine
  test keys never count.
- **The folders, held.** Once approved, the scratch folder and its `Chromium` folder are created if missing and held
  open for the life of the process without delete sharing, then checked again through those handles; a folder held that
  way can't be renamed away or swapped for a junction, and a folder that is itself a link is refused.

What the marker does and doesn't protect: it marks a build CI tests, and only a build with it honours any of the above.
The gate keeps test powers off the real profile's folder for an unmodified shipped build; it is not a boundary against
someone who can write the app folder (who can add the marker, or replace `Ardia.exe` or `ArdiaApp.dll`) or who can
already read the real profile. For example, in a marker build a scratch folder whose `Default` profile folder is a
junction to the real profile's passes the gate; that gives nothing beyond copying the real profile into a scratch
folder, which a test instance is allowed to open.

`launch-smoke.ps1` checks it with the engine. With no marker, a relative folder, the real profile folder, a junction to
it, an empty `--type=` on the real profile, an approved folder while `--user-data-dir` points at the real profile or at a
junction to the approved folder, and `--load-extension` with debugging switches outside a test instance, the engine must
log its refusal (so it did start), leave the port closed, and (for the extension) never run it, while the same extension
does run in a test instance. A scratch folder with the marker must get both powers, with the port answering
`/json/version`.

## Checks

- To build the app on a PC you need Visual Studio 2022 with the C++ desktop workload and the Windows SDK
  **10.0.26100.0**, the version `Ardia.vcxproj` names; with another SDK the build stops before compiling. The
  GitHub runners have it. Then `pnpm install` and, in `apps/browser`,
  `npx react-native run-windows --release --arch x64 --no-launch --no-deploy --no-packager`.
- `.github/workflows/windows.yml` builds the x64 app on a Windows runner and runs `scripts/windows/launch-smoke.ps1`,
  which launches it three times and uploads each launch's log: a first launch (onboarding) and a launch with
  onboarding done (the browser window), each with a screenshot when the runner allows a capture, then a hidden
  self-check launch.
- A pull request gets the fast run. The `gate` job waits for a vouch, like the iPhone build. Then three things start
  together. A Linux job (`javascript`) bundles the app's JavaScript with Metro, once for both CPUs. Each CPU's build
  job (`app`, `arm64-app`, both on x64 runners) looks in the Actions cache for an app built from the same native code
  (`windows-app-<cpu>-<hash>`; the hash covers `apps/browser/windows`, each package's `package.json` and `windows`
  folder, the lockfile, the patches and the workflow) and compiles only when none is there, then saves it.
- Each CPU then has two jobs side by side on its own kind of runner: `x64` and `arm64` run the launch check's
  launches, input and self-check (`launch-smoke.ps1 -Part launch`), `x64-gate` and `arm64-gate` its test-gate checks
  (`-Part gate`). Each takes the built app, from the cache or from the build job, and when the app was reused
  `scripts/windows/rebundle.ps1` compiles the Linux bundle with the Hermes compiler saved beside that app and
  replaces the app's `Bundle` folder; a reused app carries no source maps. When the app was compiled in this run,
  the same script checks instead that the Linux bundle, compiled here, matches the build's own `Bundle` file for
  file, so the reuse path is known to test the bundle a build would make. A run that compiled launches the app as
  built too, with its own launcher; a run that reused launches only the assembled app with the engine inside.
- A push to `main` or to the Windows branch gets the full run, and so does a pull request with the `full-ci` label
  (add the label, then push or re-run the run). A pull request can read its base branch's caches and no other pull
  request's, which is why the Windows branch builds on every push: without that, each pull request into it would
  compile once for itself. A full run always compiles, saves that app for pull requests to reuse, and adds the tours, the
  installers and the install check. Only a full run has the `Ardia-Setup-<cpu>` artifacts that
  `scripts/windows/publish-alpha.sh` publishes.
- With the browser window open, the x64 run also drives the app with real input and fails when the default layout
  marks no caption region; a drag by the gap beside the window buttons is not Windows' own move or does not move the
  window by the dragged distance; dragging it to the top edge does not maximize the window or dragging back down does
  not restore its size; a double click there does not maximize or restore it; the app's maximize, restore or minimize
  button does not do so; a drag of the toolbar's empty middle is not the app's own move; Ctrl+T matches no command; the sidebar button does not take its click; or the pointer just outside the
  window's left edge does not bring the hidden sidebar's edge over and away. The ARM runner's desktop is covered by
  Windows' own first-run screen, so its screenshots show that screen and it skips the input.
- After assembling, `scripts/windows/dependency-check.ps1` (x64 and ARM64) reads the import table, delay-load table and
  forwarded exports of every PE file in the folder (`pe-imports.ps1`) and fails when a DLL they name is neither in
  the folder, an API set (`api-ms-win-*`, `ext-ms-*`), nor on its explicit list of DLLs a clean Windows 11 ships in
  System32 (checked against a clean 25H2 install). The Visual C++ runtime (`vcruntime*`, `msvcp*`, `concrt*`,
  `vccorlib*`, `vcomp*`, `vcamp*`, `ucrtbased`) can never be on that list. `pe-imports.test.ps1` checks the reader and
  the runtime deployment against PE images it builds in memory. A new system DLL an engine or app update imports goes
  on the list once it is confirmed in a clean Windows 11's System32.
- Both runs then write the library's WinRT list into a copy of `Ardia.exe` with `scripts/windows/host-manifest.ps1`
  and read it back, so the script the engine's launcher depends on is exercised on every build.
- `scripts/windows/tour.ps1` drives a full screenshot tour and writes `tour.md`, one line per stop with the facts it
  read. Among them: Downloads and Search Tabs must close on Escape (the caption regions go away while one is open and
  come back, and for Downloads the log shows the native Escape capture taking the key), and Little Ardia's command
  panel must be drawn whole below its field, with the window buttons on the bare bar (screen brightness where the
  panel used to be cut off, and under the buttons). In Settings › Appearance it clicks the Light tile's picture, found by UI Automation,
  and then Automatic's, and each must change `appearance` in `session.json`.
- The self-check (`--self-check`, only in a test instance, see Test instances; so are the file-drop fixtures it uses) runs
  `packages/expo-windows/src/selfCheck`: each area exercises its native code from inside the real app, and the
  launch fails if any check does. A new native method gets a check there. It also renders every view drawn in JS
  in the window (`selfCheck/stage.tsx`), writes `config.json` and waits for the watcher's `onChange`
  (`ARDIA_CONFIG_DIR` points the config folder at the data folder for that), and moves a file to the Recycle Bin.
- The smoke launch fails when the browser window answers `WM_GETICON` with no big or small icon, or the launch log
  does not show the AppUserModelID and the window icon; the installer check fails when the Start menu shortcut lacks
  the AppUserModelID or an icon file, the uninstall entry's icon is not a file, or the installed `Ardia.exe` does not
  carry Ardia's icon and name.
- `platform/windowsModules.test.mjs` fails when the app imports something from `expo-modules-core` that
  `packages/expo-windows` doesn't export.
- Nobody can compile Windows code on the Mac: CI is the compiler. The Windows VM on shiv covers behaviour by hand,
  with an ARM64 build. Speed numbers and the x64 build need real hardware before a release.

## Speed targets

The Mac's numbers are the targets for Windows, measured from the first engine build on. These are 0.2.45's, from
`docs/perf/0.2.44-to-0.2.45.md`; use the latest release's when measuring.

| Measure | Mac |
| --- | --- |
| Launch to window shown | 451 ms |
| Tab switch to shown | 9 ms |
| New tab to first paint | 78 ms |

## What still separates Windows from the Mac (2026-11-14 walk, brought up to date on 2026-11-15)

Ranked by how much a user notices. Sizes are rough: S is under a day, M is one to three days, L is more.

App side, an agent can do these now:
1. A new tab opened with an address (Ctrl+T, the address, Enter) gets no keyboard (#1689). S, with the engine
   thread.
2. Changing a Windows contrast theme while Settings is open crashes Ardia, inside the Windows App SDK (#1900). S once
   the cause is seen on Windows.
3. A private pop-up left as the only window closes the tabs it opens at once, where a regular one gets a browser window
   back (#1910): the app can't open a window on the pop-up's private session yet. S.
4. The top edge over a page that reaches it (#1888): a real drag in CI resizes the window from the top; the cursor, a
   double click and a maximized window are untried in the VM. S.
5. The theme's grain draws nothing, and the sidebar and toolbar don't blur what is behind them (#1921). M.
6. The Mac's own items in the page menu: search a selection with Ardia's engine and Share (Chromium's menu is otherwise
   trimmed as on the Mac since #1811). S.
7. The app's own prompts for passwords, notifications and location, drawn like the Mac's (#1425 for the events the app
   needs). M each once the engine reports them. A pop-up's prompts go to its opener's window, as on the Mac's
   `ArdiaPopupWindow` (else any window of its profile). Today Chromium's own prompt shows, most likely in the
   pop-up's window (not yet seen in the VM).
8. Picture in picture: the Mac's stash, corners and mini player (#1425 for the window events). L.
9. A pop-up whose opener wrote its document shows about:blank in its origin strip (#1863). S.
10. Dragging a pinned extension to reorder the toolbar (main's #1935): the engine takes `pinnedIndex` since
    `windows-engine-20261115-3`; that the new order sticks, and the drag itself, are untried on Windows. S.
11. A group's and a live folder's icon is the plain folder symbol, filled while open, not the Mac's animated folder
    (main's #376; `views/FolderIcon.tsx`). S.

Engine work (#1425): the walk found nothing new missing beyond what is already listed there:
- password sync on Windows: the engine's login read is ready (#1918); Sync still has to handle its errors before
  `syncsPasswords` turns on;
- the password, permission and picture-in-picture events the app needs to draw its own prompts and windows;
- the 67 calls `packages/expo-windows/src/engine/domains/forwarded.json` lists under `missing`;
- nothing else open from the 2026-11-14 walk: a tab the app closes no longer prompts and is gone within its deadlines
  (#1696), a data: page's app-link prompt needs its document alive (#1750), the first click on a page prompt works after
  using the page (#1749), and the app process exits at once after quit (#1761).

Decisions for Shivam:
- the calendar source on Windows (#1521);
- Translate (#1520);
- signing, or a per-machine install (#1659).

With the engine and owner items set aside, the app side has not reached parity yet: items 1 to 4, 9 and 10 are bugs a
user hits, and 5 to 8 and 11 are visible differences from the Mac. Everything else in the table works or differs
only where the engine, Windows itself or a decision stands in the way.

## Order of work

1. The app shell: the UI in native windows, with the app-side native modules and views. Done in #1112, except what
   the log still lists.
2. Chromium for Windows with our patches, hosted in the app: pages load in tabs. Done (The engine in the app).
3. What the Mac's native layer does that Windows still leaves to Chromium's own UI or lacks: the page's context menu,
   permission, password and autofill prompts drawn by the app, popup windows in the app's own frame, picture in
   picture, the page script, full screen video inside the app's window, session restore of a tab's history.
4. The Windows versions of the Mac-specific engine patches.
5. C++ versions of what is still drawn flat or missing: shaders with Direct3D, dragging files out of the app, swipe
   gestures. Import from another browser is done for bookmarks, history, open tabs, favicons, Chromium passwords and
   cookies, and HTML and CSV files; what is left is listed under Import from another browser.
6. An installer exists (`scripts/windows/make-installer.ps1`, Inno Setup, per user, no admin prompt; CI builds
   `Ardia-Setup-<cpu>.exe` and installs and uninstalls it), every release ships them and refreshes the feed, and the
   app updates itself from it (Updates, below). Left: signing both.
