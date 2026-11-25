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

## The default shell (#4142, #4143)

Windows is the Chromium WebUI shell: Chromium is the app and serves the shared desktop UI (`apps/desktop`, its
`--mode win` build) from `chrome://ardia/`, as on Linux. CI, the Release workflow and `windows-alpha` build, test and
publish only the WebUI installers (`assemble-webui.ps1 -Shippable`, `make-installer.ps1`), and `publish-alpha.sh`
publishes only builds whose `Ardia.build.json` names `"shell": "webui"`. The React
Native Windows app (`apps/browser/windows`, `packages/expo-windows`) was deleted in #4143; only the icon and
`EngineApi.h` stay in `apps/browser/windows/Ardia`, since the installer, the Windows engine's build and its key read
them, with `SyncWordlist.h`, the wordlist copy `ardia-sync-vectors` checks (its test is a Linux engine key input). The engine still picks the shell as #4162 left it (a browser process with no `--ardia-shell` switch starts the
WebUI shell unless `ArdiaApp.dll` sits beside the launcher), so its React Native branch is now dormant: no install
ships `ArdiaApp.dll`, and removing that branch is an engine change for a later engine.

An install of the React Native shell still upgrades: the WebUI installer removes the files the React Native shell
shipped (`RetiredShell "rnw"` in `Ardia.iss`, `shell-layout.ps1`'s list), moves its login item, and
`ardia-webui-migrate.exe` moves its data on the first WebUI start ("Moving a user's data from the RNW shell" below).
The login item: the WebUI shell's Open at Login is `Run\Ardia WebUI` (with `--ardia-shell=webui`), the React Native
app's was `Run\Ardia`. `UpdateLoginItems` in `Ardia.iss` moves `Run\Ardia`, when it launches this install's
`Ardia.exe` with no arguments or only a shell switch, to `Run\Ardia WebUI` and the WebUI command. Its
`StartupApproved\Run` state comes along, written first: when `Ardia WebUI` had no item, the old item's approval bytes
replace any orphan an earlier Open at Login left there (or that orphan is deleted when the old item had none, and an
approval that exists but can't be read stops the move), so an item Windows disabled stays disabled and an orphan never
flips one; a live `Ardia WebUI` item keeps its own approval, or none, which means enabled. Only after the approval and
the new item are written is the old value deleted, and its approval only once the old value is gone; if either write
fails, the old item stays, rewritten in place. A custom `Ardia WebUI` value is never overwritten, and nothing is
created where neither exists. Sections below that still name the React Native app describe what it did, for that
upgrade.

## The engine in the app

The engine is Chromium's own browser, built for Windows with our patches (`docs/engine-build-windows.md`). The product
is one folder: Chromium's launcher as `Ardia.exe`, `chrome.dll` and the engine's files, the shared desktop UI as
`ardia-ui\` (`pnpm -C apps/desktop build:win`, served from `chrome://ardia/`), `ardia-webui-migrate.exe`,
`ardia-update-verify.exe` with the pinned `windows-update.pem`, and `Ardia.build.json`. `scripts/windows/assemble-webui.ps1`
puts an engine and that UI build together and gives the launcher Ardia's icon and name ("Packaging, installing and
upgrading the WebUI shell" below has its switches). A browser process started without `--ardia-shell` or `--headless` opens the
WebUI shell in the WebUI profile (`%LOCALAPPDATA%\Ardia WebUI\Chromium`), as `--ardia-shell=webui` does, and a child
process (`--type=` with a value) is no shell ("Selecting the shell and keeping real data out" below). The engine's
React Native branch, taken only with `--ardia-shell=rnw` or with `ArdiaApp.dll` beside the launcher, is dormant, since no install ships that file.
The bullets below that name the React Native app describe what it did, for an upgrade from it.

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
  `assemble-webui.ps1` (`vc-runtime.ps1`) reads every PE file's imports, delay-loads and forwarded exports and copies each
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
  goes to the app window (#2051; `Test-PageHoldsPlace` in the deleted `launch-smoke.ps1` checked it). The guard stays on the window through Memory
  Saver: a hidden page that sleeps keeps it, and the page holds its place again once it wakes (`engineSleepPlace.ts`). A window
  Chromium opens by itself (a link opened in a new window) stays off screen until the app adopts its tabs.
- The verbs: `tab.create` (a key, a profile, a URL or a tab to adopt; the same key again moves the tab to the window
  that asks), `tab.show` (visible, and where in the window, in the UI's points; a corner radius and holes),
  `tab.close`, `tab.call` (load, back, forward, reload, stop, find, zoom, scripts, DevTools, print, site info and the
  rest of the Mac tab's methods, `tab_calls.cc`), `tab.discard`, `tabs.list`, `host.info`, `renderer.efficiencyCounts` (takes the hourly counts), `renderer.efficiency`
  (a tab's renderer: pid, priority, memory priority, power throttling), `app.quit`. Events come as
  the topic `tab` with a key, a name and data (navigation, progress, favicon, find, zoom, security, media, pagePress,
  windowClose and more), and `tab.opened` for a tab Chromium made itself, with who opened it.
- The page view (`engine/EngineWebView.tsx`) is the native view under the shared `WebView`, so its handle is typed as
  `WebViewNativeHandle` from `@ardia/ardiacore`, the calls the shared `WebView` makes on the Mac's view: a method
  added to that contract that Windows lacks fails `pnpm -C packages/expo-windows typecheck`. Each method goes to `tab.call`
  (`engine/pageCalls.ts`), is answered in TypeScript (`capturePicture`, `downloadFavicon`, `focusIfUnfocused`), or is
  in `NOT_ON_WINDOWS_YET`, which answers the Mac's empty answer and logs the method once. Those need the engine:
  `downloadImage`, `requestPictureInPicture`, `takeControlPress`, `exitPictureInPicture`, `resolvePasswordPrompt`,
  `resolveAutofillPrompt`, `answerAutofillPrompt`, `executeExtensionAction`, `resolveDisplayMedia` (Chromium's own
  picker shows), `mediaCaptureSourceId` and `notificationAction`. A failed `tab.call` rejects with the engine's error,
  as on the Mac, an `evaluate` result, navigation list or cookie list of the wrong type rejects with `ERR_BAD_REPLY`,
  and a closed page answers the empty answer. A focus the page takes only once it shows logs `could not take focus`
  when the engine refuses it. `nativeTag` is null: a page is its own window, with no React Native tag to hand keyboard
  focus to.
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
- **Crash reports.** `ArdiaApp.crashReports(since)` lists the minidumps Chromium's crash handler (Crashpad) wrote after
  `since` (milliseconds), so the telemetry owner's native-crash report (`reportNativeCrashes`, the same consent as the
  Mac and Linux) can name what ended a run on the next launch. It used to answer an empty list, so a Windows crash left
  no report (#3664). `CrashDumps.h` does the work and uses only the standard library, so a test compiles it on any
  machine; `AppModule.h` picks the folders and builds the JS objects.
  - Where: the profile's `Crashpad\reports` folder (`%LOCALAPPDATA%\Ardia\User Data` for an everyday instance, the
    instance's data folder for a test instance, whose dumps then never reach the everyday profile). Files over 32 MB
    and empty or damaged ones are skipped. Every dump newer than the asking time is read (Crashpad prunes the folder
    itself), so a burst of helper dumps can't hide an older browser one; then the newest five from the browser process
    and five from the others are kept, as on Linux. A file's time is converted with the file clock, so asking again from
    a report's `fileTime` never returns that dump again. The walk runs on its own thread, so it never holds the UI thread.
  - What is read: the minidump's header, exception stream, module list and process times (bounds-checked, nothing is
    executed) and three of Crashpad's annotations, `ptype`, `ver` and `ardia-ver`; every other annotation, the stacks,
    the memory and the thread contexts are never copied. A dump written without a crash (Crashpad's simulated-exception
    code) or without an exception stream is skipped.
  - What comes back (`CrashReport`): the process kind (`ptype`; none means the browser), `terminationNamespace`
    `WIN32_EXCEPTION`, the exception as its Windows name (`EXCEPTION_ACCESS_VIOLATION`, `STATUS_STACK_BUFFER_OVERRUN`,
    or `STATUS_XXXXXXXX` for a code with no name), for an access violation whether it read, wrote or executed, one
    frame naming the faulting module's file name and the offset in it (`nvoglv64.dll` +`0x1234`, `???` when the
    address is in no module or the name isn't a plain `.dll`, `.exe`, `.sys`, `.drv`, `.ocx` or `.cpl` file name), the seconds the process had run (the dump's time minus its start time), the engine
    version for a helper process (kept only when it has the shape of a version), and the dump's time and its file's modification time. No folder or file path, URL, page title or user
    name is returned, and the module name has its folder cut off. The parser also reads an `ardia-ver` annotation as the
    browser's app version, but no Windows build writes one yet, so a browser report carries no version. A browser-process
    crash may also never reach Crashpad at all; that is #3665.
  - `ArdiaApp.devWriteCrashFixture(name, hex)` writes a dump into that folder for the self-check. It refuses unless the
    instance is a test instance, and refuses any name but letters, digits and dashes before `.dmp`, and Windows'
    reserved device names. It answers true or false,
    never a path.
  - Self-check (`appSystem.ts`, `sampleMinidump.ts`): the inert-calls check asks for reports newer than tomorrow and
    expects none; two more write a GPU-process dump (access violation in `nvoglv64.dll`, uptime 3 s, an engine
    version) and a browser dump (stack buffer overrun in `Ardia.exe`, an app version) and read each back through
    `crashReports(0)`. `windowsCrashReports.test.mjs` compiles the same parser with the system C++ compiler and
    checks the dumps the self-check builds, plus damaged, oversized, simulated and hostile ones.
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
  area of another tab (its New Tab page, an empty split pane, an internal page: `TabPane`'s `NewTabDropArea` and
  `InternalPage`, whose `contentAreaOf` prop the field walk reads) doesn't count either, since the new page replaces
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
  steps. A new engine build is a new release and a new `prebuilt.json`, whose `source` is the commit it was built from
  and `key` that commit's Windows engine key (`engine/engine-key.sh --platform win <source>`).
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

## Updates

- The updates live on the GitHub prerelease `windows-alpha`: `Ardia-Setup-x64.exe`, `Ardia-Setup-arm64.exe`, the
  feed `windows-update.json` (version, build, and per CPU the installer's address, SHA-256 and size), its raw 64-byte
  Ed25519 signature `windows-update.json.sig`, and the engine's source. `scripts/windows/publish-alpha.sh` signs the
  feed with `scripts/windows/sign-update.mjs` (using `--key`, `WINDOWS_UPDATE_KEY_FILE` or
  `WINDOWS_UPDATE_ED_PRIVATE_KEY`, checked against `scripts/windows/windows-update.pem`) and self-verifies
  `windows-update.json`, `windows-update.json.sig` and both installers with `ardia-update-verify` before uploading,
  putting the feed and its `.sig` up after the installers. A live publish without a signing key fails closed;
  `--dry-run` without a key signs with an ephemeral test key so the verification path still runs. Keeping
  `windows-update.json`'s JSON shape unchanged and carrying the signature in `windows-update.json.sig` lets older
  unsigned installs keep updating while new installs enforce the signature. It keeps the installers of the build
  before, so an update the app already offered still downloads, and removes older ones. It refuses a build at or below
  the live feed's, since no installed app would take it.
- Every release refreshes it (Releases, below), so installed Windows apps update to each nightly and stable.
  Between releases, dispatch `.github/workflows/windows-alpha.yml` with a green Windows workflow run id so alpha
  publishes share the `ardia-windows-alpha-publish` concurrency group with `release.yml` (`scripts/windows/publish-alpha.sh`
  refuses live local publishes unless `--allow-local-publish` is explicitly passed; `--dry-run` works locally).
- A build knows what it is from `Ardia.build.json` beside `Ardia.exe` (`assemble-webui.ps1 -Version -Build`, which
  also stamps `"shell": "webui"`). The build
  number is the number of commits in the built commit's history (`git rev-list --count`, the workflow's `identity`
  job), so it grows with `main` and a release outranks every build before it, CI's included; builds before this rule
  were numbered by the run (up to about 670). The Windows workflow puts the same file beside the installer in its
  `Ardia-Setup-<cpu>` artifact, which is where `publish-alpha.sh` reads a build's version and number. `ArdiaApp.systemInfo` takes its version and build from that file, since the library has no version
  resource, so telemetry, About and problem reports name the build; a folder build without it says 0.0.0, build 0. Only an installed build with that file updates: Settings › General › Updates shows "not set up" for a
  folder build.
- The WebUI shell updates from the signed feed. Its native half is
  `scripts/windows/engine/src/ardia/win/webui/webui_updates.cc`, which serves `ArdiaUpdates.installKind`, `status`,
  `check`, `update`, `claimOutcome` and `restart` to the shell; the rules it follows are in `webui_update_policy.h` and
  tested by `scripts/windows/engine/tests/webui_update_policy_test.cc`. `check` fetches the feed and its signature
  through Chromium's network stack (a redirect only to GitHub's release hosts over https), stages them in a fresh
  folder under `<app data>\Updates` that is never a link, and runs `ardia-update-verify.exe windows-manifest` against
  `windows-update.pem` beside `Ardia.exe`. Each staged file is created with `CREATE_NEW` and no sharing, checked
  before a byte is written, then reopened read-only (only `FILE_SHARE_READ`) as the same file and held while the
  verifier reads it. The verified offer stays in the browser process: the shell only says which build to download,
  never a URL, hash or path. `update` streams the installer into an unpredictably named staging file, hashing it as it
  is written, renames it to `Ardia-Setup-<sha16>.exe` through its handle, reopens it read-only (no `DELETE` access, so
  `CreateProcessW` can open it, and only `FILE_SHARE_READ`) as the same file and holds that handle
  through `windows-package` and until `restart` starts it with the RNW updater's silent arguments and quits, so nothing
  can change it in between. One install runs at a time: a second `restart`, from any window, answers `busy`, and a
  launch that fails releases the held installer. A file that fails a check is deleted only through its own handle,
  never by path. A hidden instance never starts it. `claimOutcome` answers with the outcome it consumed, and each run
  keeps the consent period it started in (in `windows-updates.json`), so a window that settles another window's run
  counts it under that period or not at all. `update` says whether it started the run, so a stale Update click in another
  window never takes over the run's consent period. The kind is `installer` beside
  `unins000.exe`, `portable` without it, and `unsupported` without the verifier, key or `Ardia.build.json`.
- The WebUI side in the shared UI is `apps/desktop/src/platform/win/hostUpdates.ts` (wired through `updater.win.ts`
  and `updates.win.ts`). It keeps the RNW behaviour: checks 30 s after launch and every 6 hours from one window, never
  in a hidden instance or a scratch data folder (an app-data folder other than `%LOCALAPPDATA%\Ardia WebUI`) unless a
  test instance names `updateFeed`, preferences in
  `windows-updates.json`, and the app menu's Check for Updates… turns into Restart to Update once the installer is
  ready. A portable copy points to the release page. It reuses the existing counts: `update_checks_*`,
  `update_downloads_*`, `update_download_failures_<reason>`, `update_install_failures_<reason>`, `update_restarts` and
  `windows_update_manifest_*`.
- `assemble-webui.ps1 -Shippable` needs `-UpdateVerify <ardia-update-verify.exe>` and copies the pinned
  `scripts/windows/windows-update.pem` beside it. Both files are in `$ShellKept` (`shell-layout.ps1`), which
  `make-installer.ps1` hands to `Ardia.iss` as `kept-files.txt`. Switching shells or updating within a shell never
  removes them, even when an older install's manifest still lists them as React Native files.

## Releases

The Release workflow (`.github/workflows/release.yml`, dispatched by the `release` skill) builds Windows next to the
Mac, for every nightly and stable:

1. Its `windows` job calls `windows.yml` with the release's version, at the release's commit: the same build, pinned
   engine (`scripts/windows/engine/prebuilt.json`), launch, tour and installer checks as CI, for x64 and arm64. The
   installers it ships are the WebUI shell's (the `webui` and `webui-arm64` jobs).
   `release-files.ps1` names each tested installer `Ardia-<version>-windows-<cpu>-setup.exe` with its `.sha256`, and
   the job leaves them with `Ardia.build.json` in the artifacts `windows-release-x64` and `windows-release-arm64`. Its
   `source` job packs the engine's source, `Ardia-<version>-windows-source.tar.xz` with a `.sha256`, in
   `windows-release-source`: `scripts/windows/engine-source.sh`, from the Helium tags `helium-pins.ini` pins at the
   commit `prebuilt.json` names as its engine's `source`, so the archive matches the engine the installers carry even
   when the pins have moved on ahead of a new prebuilt. Its README names Chromium's source, this repository's tree at
   that engine commit, and the tree at the release's commit for the app.
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
scripts/windows/publish-alpha.sh --allow-local-publish --installers dist/<version>/windows --commit v<version>
```

When the cause is in the code (a stale engine pin needs a new engine release and `prebuilt.json`), fix it on `main`;
Windows skips this version and ships with the next release. When only `windows-update` failed, the installers are on
the release already: re-run that job alone (its re-run touches nothing else), or run the last line above on its
`windows-release-*` artifacts, flattened into one folder as above.

## Test instances

Whether a launch is a test instance is decided once, by the engine, before Chromium starts (`DecideTestGate` in
`main.cc`, the rule in `scripts/windows/engine/src/ardia/win/test_gate.cc`), from `ARDIA_DATA_DIR`,
`ARDIA_REMOTE_DEBUGGING_PORT`, `ARDIA_TEST` and `ARDIA_TRACE`. The WebUI shell reads nothing else from the environment
to get test powers, and `EngineApi.h`'s `testGateRefusal()` hands the same decision to anything that asks later.

A test instance needs all of:

- an absolute `ARDIA_DATA_DIR` (not `C:foo` or `\foo`);
- that folder and its `Chromium` folder, compared by their final paths on a local volume (junctions, `subst` drives and
  8.3 names resolved), are not, inside or around the real profile folders (`%LOCALAPPDATA%\Ardia WebUI`, and the
  React Native app's `%LOCALAPPDATA%\Ardia` and `%APPDATA%\Ardia` an upgraded install may still hold);
- a test build: an `Ardia.test-build` file beside `Ardia.exe`.

Windows builds are not signed yet, and the alpha publishes the exact installer CI built and tested, so no build flag
can tell a published build from a tested one. The marker does instead: CI's tour step writes it into a copy of the
assembled build before `tour-webui.ps1` runs it, `assemble-webui.ps1` writes it only with `-TestBuild` and refuses it
with `-Shippable`, `make-installer.ps1` refuses a folder that holds it and `installer-check.ps1` fails when an install
carries it. So a build installed from the alpha, or updated to by the
app, ignores test keys. A VM script that tests an installed build with test keys writes the marker into the install
folder first. That folder is the user's to write, like the Mac's app bundle: anyone who can drop the marker can also
replace `chrome.dll`, and on the Mac a changed bundle is likewise no longer signed for distribution.

What it guards: the unmodified build people install can't be switched into test behaviour by the environment alone,
and a test instance never runs on the real profile folders by mistake. What it doesn't: code already running as the
user, which can plant the marker, race the folder check with a junction, or hard-link a scratch file to a real one.
That code can also decrypt the real profile's DPAPI secrets directly, without Ardia; the Mac's keychain ties its items
to the signed app, and Windows has nothing like it until builds are signed or installed per machine. A scratch folder
that can't be resolved on a local volume doesn't count.

Secrets stay apart the way the Mac's mock keychain keeps them: Chromium's key sits in the data folder's `Local State`,
sealed by DPAPI, so a test instance's scratch profile never shares the real profile's key.

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
  `--utility-cmd-prefix`, `--gpu-launcher`, `--no-sandbox`; nothing in the engine or the probe passes them, and CI
  passes them only in `test-gate-check.ps1` to verify they are stripped), and
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
someone who can write the app folder (who can add the marker, or replace `Ardia.exe` or `chrome.dll`) or who can
already read the real profile. For example, in a marker build a scratch folder whose `Default` profile folder is a
junction to the real profile's passes the gate; that gives nothing beyond copying the real profile into a scratch
folder, which a test instance is allowed to open.

CI checks both sides in `.github/workflows/windows.yml`'s `webui` job: `tour-webui.ps1` runs a marked copy as a test
instance and needs the debugging port to answer, and `scripts/windows/webui-pilot/test-gate-check.ps1` runs private
unmarked and marked copies of the assembled build to check the refusals (no `Ardia.test-build` marker, a relative
`ARDIA_DATA_DIR` refused early with exit 1, a junction as `ARDIA_DATA_DIR`, `%LOCALAPPDATA%\Ardia WebUI` and a junction
to it, `%LOCALAPPDATA%\Ardia` and a junction to it refused at `install_static`, an empty `--type=` on the real WebUI
profile, a `--user-data-dir` pointing into `%LOCALAPPDATA%\Ardia\User Data` or elsewhere without a scratch
`ARDIA_DATA_DIR`, and `--load-extension` with debugging and child-launch switches stripped outside a test instance,
checked on live child command lines and via `cors-probe.mjs` for `--disable-web-security`) alongside positive controls
for a marked scratch test instance, `--load-extension`, renderer switch propagation, and cross-origin fetch when
`--disable-web-security` is kept.

## Speed targets

The Mac's numbers are the targets for Windows, measured from the first engine build on. These are 0.2.45's, from
`docs/perf/0.2.44-to-0.2.45.md`; use the latest release's when measuring.

| Measure | Mac |
| --- | --- |
| Launch to window shown | 451 ms |
| Tab switch to shown | 9 ms |
| New tab to first paint | 78 ms |

## WebUI pilot (`--ardia-shell=webui`)

Issue #3686, part of #3678 (Track 4 of the cross-platform design: Windows on the desktop host). The pilot asks whether
Windows can drop React Native Windows and run the Linux model: Chromium is the app, and the shared desktop UI
(`apps/desktop`, built in its Linux mode) is served from `chrome://ardia/`. It proves the hard parts on one window before any
Linux patch is widened or the host is moved. Proven on 2026-11-23 in a fresh Windows 11 guest (`dockurr/windows` on
a Boat VM, 1920×1080) with a Windows x64 engine and UI bundle built from this change on `main` at `5b1e984`: the
real-input run (28 checks; 28 at 150% on the previous engine of this change, which differs only in the folder checks
below), the junction check (31, every launch's real argv checked), the bridge's hostile-input check (11 checks over
15 malformed requests, 6 bad arguments, 12 reserved tab URLs and 5 reserved navigations), the stale-document check
(8), the close-cycle check (8 closes with pass-through regions active), the policy and cleanup-race check
(`profile-edges.ps1`: a `UserDataDir` policy refused with its folder never created, and 3 of 3 launches opening while
20,000 folders in the profile were being deleted; the engine before this round wrote Crashpad files into the policy
folder and refused all 3 launches), the concurrent-runs check (`ports.ps1`) and
`install_static_unittests --gtest_filter=UserDataDir.ArdiaShell*:UserDataDir.WebUITree*` (6 tests) all passed.

### Selecting the shell and keeping real data out

- `chrome.exe --ardia-shell=webui` turns it on, and since the cutover (#4142) so does a launch without the switch
  from a folder with no `ArdiaApp.dll`. `--ardia-shell=rnw`, or no switch with `ArdiaApp.dll` beside the launcher,
  still makes `BeforeChromeMain` start React Native Windows. A child process (`--type=` with a value) is neither.
- Order in `BeforeChromeMain` (`main.cc`): the WebUI branch first makes sure Chromium will open the WebUI profile,
  then the test gate runs (as for RNW), then the WebUI branch returns **before** the `ArdiaApp.dll` check. A WebUI start
  never loads the app library, the RNW message hooks, the hosted-window frame or `AskBeforeDiscards`.
- Its own folders: app data in `%LOCALAPPDATA%\Ardia WebUI` (a sibling of the RNW app's `%LOCALAPPDATA%\Ardia`, never
  inside it) and Chromium's profile in `%LOCALAPPDATA%\Ardia WebUI\Chromium`. A test instance's `ARDIA_DATA_DIR` is
  used as is (`<ARDIA_DATA_DIR>\Chromium`), so the test gate, CDP and scratch-folder rules are the RNW ones.
- Chromium on Windows takes its profile folder from `install_static`, which `chrome_elf` computes from the process's
  real command line before any Ardia code runs, and opens Crashpad's database there; changing `--user-data-dir` in
  `BeforeChromeMain` does nothing (the first pilot run opened the wrong folder). So `chromium-win-webui-user-data-dir.patch`
  (the one Windows patch the pilot adds, after `chromium-win-install-names.patch`) decides it in `install_static`:
  with `--ardia-shell=webui` and no `--user-data-dir`, policy or `ARDIA_DATA_DIR` naming another folder, it picks
  `%LOCALAPPDATA%\Ardia WebUI\Chromium`.
- **Both stages read the switch the same way.** `install_static::IsWebUIShellCommandLine` repeats what
  `base::CommandLine::ParseFromString` and `AppendSwitchesAndArguments` do in Chromium 158 (`base/command_line.cc`):
  trim the whole command line with base's whitespace set, split it as `CommandLineToArgvW` does (`install_static`'s
  `TokenizeCommandLineToArray`), skip the program, trim each argument, stop reading switches at `--`, take `--`, `-`
  or `/` as a prefix, stop at `single-argument` compared case-sensitively before the name is lowercased (so
  `--SINGLE-ARGUMENT` is an ordinary switch, as in base), lowercase the name, and let the last value win.
  `install_static_unittests` runs the same 48 command lines through both parsers (`UserDataDir.ArdiaShell*`: trimming,
  `--single-argument` in three cases, quotes, `=` and repeated switches) and checks the tokens against
  `CommandLineToArgvW`. At startup `BeforeChromeMain` also asks both and exits with code 1 if they disagree
  (`RefuseShellModeDisagreement`), so a spelling the two parsers read differently stops the engine instead of
  opening one profile in the other's mode.
- Whichever folder was chosen (command line, policy, `ARDIA_DATA_DIR` or that default) is resolved through the opened
  handle of its nearest existing part (`GetFinalPathNameByHandle`, by volume GUID, so `\\?\`, 8.3, UNC
  `\\localhost\C$`, `subst` and junction spellings all land on one path), before it is created and again after.
  It is compared with the React Native app's folders resolved the same way: `%LOCALAPPDATA%\Ardia` and `%APPDATA%\Ardia`
  and their `User Data` folders (followed wherever a junction moved them). If they are the same, one contains the
  other, a folder can't be resolved, or the chosen folder can't be created, the process exits with code 1 there,
  before Crashpad starts. There is no fallback: neither Chromium's default folder (the React Native app's) nor a
  temporary one.
- **No links inside the WebUI tree.** After the folder is created, `install_static` walks the whole profile tree
  (`WebUITreeHasLink`: `FindFirstFileEx`, never following a link) and exits with code 1 if any file or folder in it
  is a reparse point: a junction, a directory or file symlink, at any depth. Ardia's own check walks the WebUI
  app-data folder with the same function. The pilot's tree is its own, so the walk is bounded, and it doesn't matter
  where a link points: a stale link to an unrelated folder refuses too. The WebUI folder itself may still be a link
  (a profile moved to another drive); its target is what gets compared above. Only a reparse attribute refuses.
  A folder that disappears between being listed and being opened (`ERROR_FILE_NOT_FOUND`, `ERROR_PATH_NOT_FOUND`)
  is skipped, so the running shell clearing its caches can't stop a second launch; so is a subfolder that answers
  `ERROR_ACCESS_DENIED`, because a folder being deleted while something still holds it open answers exactly that,
  and a folder in the user's own profile that the user can't list could only have been locked down by a process
  running as the user, which is out of scope below. If the profile folder itself can't be listed for any reason
  other than being gone, or a subfolder fails any other way, the walk can't vouch for the tree and the shell
  refuses to start. `install_static_unittests` (`UserDataDir.WebUITreeWalk*`) checks a plain tree, a subfolder and
  the root removed just before they're listed, and a directory symlink.
- **No managed relocation.** If a `UserDataDir` policy is set (HKLM or HKCU, under the install's
  `SOFTWARE\Policies` key that `install_static` reads), it moves the React Native app's profile and would also decide
  the WebUI shell's, so the WebUI shell exits with code 1 in `install_static`, before Crashpad opens anything there.
  The pilot doesn't support managed profile relocation.
- After those checks `install_static` keeps a handle open on the profile folder for the life of the process, opened
  with `FILE_LIST_DIRECTORY | SYNCHRONIZE` and sharing read and write but not delete, and hands Chromium the handle's
  final path, not the spelling it was given. A handle with no access rights is left out of Windows' sharing check, so
  it is the real access that makes the missing delete share hold: while the handle is open, renaming or deleting the
  folder fails, and so does renaming the folder above it, because NTFS doesn't rename a folder with an open handle
  inside.
- **What is left.**
  - Between resolving the folder and opening that handle (microseconds, before Crashpad or chrome.dll), and between
    the tree walk and Chromium opening each file, another process could swap a parent folder or plant a link. Only a
    process running as the same user can do that, and such a process can already write both profiles directly, so
    the race gives it nothing it doesn't have. Closing it fully would mean handing Crashpad and Chromium an open
    handle instead of a path, which is out of scope for the pilot.
  - Links someone deliberately puts inside the React Native app's own profile pointing into the WebUI tree are out of
    scope for the same reason: only a same-user process can make them, and the WebUI shell doesn't walk the React
    Native profile at startup. The checks are there against mistakes and stale links, not against code already
    running as the user.
- If the folder Chromium will use is safe but isn't the WebUI one (an explicit `--user-data-dir`), the engine starts
  itself again with the WebUI folder and exits (`RelaunchIntoWebUIProfile`, once: a second mismatch refuses to start).
  Folders are compared by resolved path (`SameFolder`), not by spelling.
- Ardia's own code checks again before Chromium opens the profile (`ReactNativeFolderClash`, the test gate's
  `CanonicalPath`, with the same set of React Native folders and the link walk) and exits with code 1 on the same
  conditions.
- Checked in a throwaway Windows 11 guest by `scripts/windows/webui-pilot/junction.ps1`. It never touches the account's
  own folders: every launch gets `LOCALAPPDATA` and `APPDATA` inside a run folder of its own under `C:\pilot\runs`,
  marked with a `.pilot-run` file holding a fresh id, and the harness deletes only a folder whose marker names it
  (links are unlinked first, never followed). Each launch starts suspended, the harness reads its real command line
  back and splits it with `CommandLineToArgvW`, and a case counts only if the engine got exactly the arguments meant.
  Each of these exits 1 with no window, and no file or folder in the React Native folder is added, removed or
  changed: `Ardia WebUI` as a junction to `Ardia` (with the switch also spelled `--ARDIA-SHELL`, `-ardia-shell`,
  `/ardia-shell`, `--Ardia-Shell`, padded with spaces, and after `--SINGLE-ARGUMENT`); `Ardia WebUI\Chromium` as a
  junction to `Ardia\User Data`; a junction and a directory symlink at depth 1 (`Chromium\Default`) and at depth 3
  (`Chromium\Default\Local Storage\leveldb`) into the React Native profile, a junction to an unrelated folder, a
  file symlink to its `Local State`, and a junction beside `Chromium` in the app-data folder; `--user-data-dir`
  pointing into `Ardia\User Data`, also spelled `\\?\…`, as its 8.3 short name and as `\\localhost\C$\…`;
  `ARDIA_DATA_DIR` pointing at `Ardia`; `Ardia WebUI` made a file, so the profile folder can't be created; and
  `Ardia\User Data` moved elsewhere behind a junction with `Ardia WebUI\Chromium` joined to the same place. The same
  launch with none of these opens the window in `Ardia WebUI\Chromium` (also with the switch spelled upper case or
  with one dash, and with a `--user-data-dir` that has a space in it), and `Ardia WebUI` can't be renamed while it
  runs. With `ARDIA_TEST_PIN_PAUSE_MS` in a test build, `install_static` waits right after the pin, before chrome.dll
  loads or Crashpad starts; renaming `Ardia WebUI\Chromium` or `Ardia WebUI` then fails, which shows the handle
  alone holds the folder.
- The WebUI shell's session (`session.json`) lives in its app-data folder, so the launch guard's recovery sets it aside
  after unfinished starts as it does the React Native app's. A start counts as finished when the shell reports it has
  painted (`ArdiaShell.shellPainted`); if the UI bundle's entry page can't be read, the engine says which folder it
  looked in and quits instead of leaving a blank window.
- The launch guard runs for the WebUI profile: `SetAppDataDirectory` points its facts, unfinished-start count,
  restore-state recovery and launch log at the WebUI folder, and `GuardBrowserLaunch` waits on the WebUI profile's own
  mutex, so a relaunch waits for the closing WebUI instance, never for the RNW one.
- A second `--ardia-shell=webui` launch reaches the first through Chromium's process singleton (`g_ardia_win_relaunched`),
  which raises the existing window instead of opening a Chromium browser window.

### What the pilot is

| File | What it does |
| --- | --- |
| `src/ardia/win/webui/webui_mode.{h,cc}` | the switch, the folder rules above, and the one-shot startup migration hook (`RunWebUIStartupMigration`, which launches `ardia-webui-migrate.exe --from-rnw` from the executable's own folder before documents/session load, with a 60 s timeout, skipped for scratch `ARDIA_DATA_DIR` unless `--ardia-migrate-from-rnw` is passed, refused (exit 75) when that comes without a non-empty `--ardia-migrate-rnw-data=<dir>` (`StartupMigrationRequestIncomplete`), and always skipped with `--ardia-no-migrate`, non-fatal when absent). It returns a `StartupMigrationResult`, and `StartupMigrationAllowsShell` in `webui_policy.h` decides whether the writable shell opens: only when no migration was asked for, when the migrator isn't bundled, or when it exited 0. Otherwise (a non-zero exit, including `failed` 1, `refused` 2, `busy` 3 and usage 64, or a timeout, a failed launch or wait, or a migrator that fails its containment check) `OpenWebUIShell` opens no window, logs `startup migration incomplete (<outcome>)`, explains in a message box (none in a hidden instance), settles the launch guard and quits with exit code 75 (`kStartupMigrationIncompleteExitCode`). The marker is missing, so the next launch retries before anything is written on top of a partial copy |
| `src/ardia/win/webui/webui_policy.h` | pure testable helpers for Windows document names/limits (`ValidWindowsDocumentName`: 1-200 `[A-Za-z0-9._-]`, no Windows device names; `ReservedWindowsDocumentName`, case-insensitive: `session.json`, `live.json`, `live.canonical.json`, the migrator's `rnw-migration.json` and `rnw-migration.lock`, and the launch guard's `launch-starts.txt` and its `launch-starts.txt.tmp` staging file; `EngineOwnedWindowsDocumentName`: `launch-guard.json`, which `SaveLaunchGuardFacts` in `main.cc` writes at every start and the launch telemetry reads, so it stays readable and in `bootstrap.documents` but `writeDocument`, `saveDocument` and `removeDocument` refuse it in any case (`WritableWindowsDocumentName`); `WindowsDocumentLimit`: writes up to 8 MiB, 48 MiB for `sync-state.nns` in any letter case; reads up to `kWindowsDocumentReadLimit`, 64 MiB; the name and read limits equal `ardia-shell-migration`'s `DOCUMENT_NAME_LIMIT` and `DOCUMENT_LIMIT`, so a document the migrator copies under a name in that character set reads back; names with other characters, such as spaces or non-ASCII, still copy but can't be read through `readDocument`), the `bootstrap.documents` budget (`BootstrapDocumentEligible`, `BootstrapDocumentFits`: at most 128 documents and 8 MiB, checked against the listed size before a file is opened), `BootstrapAssignmentScript` (the bootstrap goes through `JSON.parse`, so a document named `__proto__` stays an own property instead of setting the prototype), `DownloadCommandForRoute` (`downloads.cancel`/`pause`/`resume`/`keep` forward `{id, command}` to `ac_downloads_command`, as on Linux), canonical final-path containment (`NormalizeWinFinalPath`, `IsStrictlyWithinWinDirectory`, `IsDirectChildOfWinDirectory`), handle-relative `FileRenameInformation` sizing/leaf validation, startup migration policy/CLI quoting, and the `HTMAXBUTTON` hover/press state machine (`MaximizeButtonStateMachine`) |
| `src/ardia/win/webui/webui_updates.{h,cc}`, `webui_update_policy.h` | the signed in-app updater's `ArdiaUpdates.*` calls (Updates, above) and their pure rules |
| `src/ardia/win/webui/webui_shell.{h,cc}` | the bridge bound to the live shell document as on Linux (`Trusted`: the shell's live primary main frame with the committed origin `chrome://ardia/`; `OwnsHandler`: the handler of that document's generation; a new document (a reload or a renderer swap) or a renderer exit retires the generation, which drops its pending replies (`DeliverReply`), its events and its pages; `OnJavascriptDisallowed` drops that handler's pending replies at once and retires the generation only if the handler no longer owns the live document; a page whose creation was asked by a retired document is never made and its profile never loaded; closing the window tears the shell down while its views are still alive (`TearDown`, from `OnWidgetDestroying` and before the widget is reset: the document is retired, in-flight telemetry posts, pages, delegate, pass-through regions and the view pointers are cleared, weak pointers are invalidated, and `ShellContents` deletes its children before its own state), so destroying the shell's WebContents can't call back into freed views; tab URLs pass one check (`AllowedPageUrl`) before any profile loads and again before a page navigates: no `javascript:`, no `chrome://ardia` in any spelling or behind `view-source:`, nothing that doesn't parse; rows in `boundaries.json`); one `views::Widget` (`ShellTreeHost`, a `DesktopWindowTreeHostWin` with Chrome's client-area insets and `WM_CAPTURECHANGED`/`WM_CANCELMODE`/`WM_ACTIVATE`/`WM_NCMOUSELEAVE` maximize-state resets; `ShellFrame`, a `views::FrameView` hit tester), the `chrome://ardia` WebUI config, handle-verified `ReadAsset` data source (regular single-link non-reparse disk file and strict final-path containment via `GetFinalPathNameByHandleW` against the opened `AssetDirectory()` handle) and `ardiaRequest` handler, desktop document store (`ArdiaShell.readDocument`/`writeDocument`/`saveDocument`/`removeDocument` and `bootstrap.documents` with strict name/device/reserved validation, `FILE_FLAG_OPEN_REPARSE_POINT`, `nNumberOfLinks == 1`, UTF-8 validation on reads, final-path direct-child checks, handle-relative `NtSetInformationFile` `FileRenameInformationEx` atomic commits and handle-based `FileDispositionInformationEx`/`FileDispositionInfo` cleanup/deletes), `ArdiaTelemetry.post` (advertised in `capabilities`; `TelemetryPostAllowed` applies `ardia::desktop_telemetry_policy::PostAcceptable` and then requires the body to parse as a JSON object, so `{` alone or `{} trailing` is refused with `ERR_TELEMETRY_REFUSED`; sent over Chromium's system `URLLoaderFactory`; in a test instance only, `ARDIA_TEST_TELEMETRY_ENDPOINT` may point it at an `http` localhost URL, and `ArdiaShell.testTelemetrySink` reports `requestsStarted`, counted where the request is handed to the network, and `inFlight`, which `bridge.ps1` uses to show refused posts never reach the network and a valid one reaches a loopback listener), `HTMAXBUTTON` hover/press tracking (`WM_NCMOUSEMOVE`, `WM_NCMOUSELEAVE` via `TME_NONCLIENT \| TME_LEAVE`, `WM_NCLBUTTONDOWN`/`UP`, deactivation/capture reset in both `PreTranslate` and `ShellTreeHost`) emitting `ArdiaShell.maximizeButtonState`, the transparent shell `WebView` above the page `WebView`s, input pass-through, page leases and navigation events, accelerators, `session.read`/`session.write`, `engine.call` for all 37 generated routes of `ardia/desktop/generated/ac_desktop_routes.h` through the Windows `ac_*` table |
| `src/ardia/win/webui/webui_caption_script.h` | lines added to `host-bootstrap.js` that report the shell's maximize button rectangle (`ArdiaShell.setMaximizeButton`) and mirror `ArdiaShell.maximizeButtonState` onto `data-ardia-nc-hover`/`data-ardia-nc-pressed` |
| `scripts/windows/assemble-webui.ps1` | engine + `apps/desktop/dist/win` (default, or any UI build folder with `index.html`) as `ardia-ui\` beside `chrome.exe`, plus optional `-MigrateBin` to bundle `ardia-webui-migrate.exe` and `-UpdateVerify` to bundle `ardia-update-verify.exe` with the pinned `windows-update.pem` beside it; `-Shippable` makes the build the installer takes (below) and needs both |
| `scripts/windows/webui-pilot/` | the real-input run below (`run.ps1`, its helpers and test page), the packaged-build tour (`tour-webui.ps1`), the stale-document check (`stale.ps1`), the hostile-input check at the bridge and document sinks (`bridge.ps1`), the junction and `ardia-ui\` asset-escape check (`junction.ps1`) and the close-cycle check (`close.ps1`), the policy and cleanup-race check (`profile-edges.ps1`) and the concurrent-runs check (`ports.ps1`); they track the processes they start and stop only those and their children, launch with `--remote-debugging-port=0` and read the port back from the run's own `DevToolsActivePort`, using it only while the process listening on it is one this run started, run each launch in its own marked folder under `C:\pilot\runs`, and delete only a folder whose `.pilot-run` marker names it |

The frontend is `apps/desktop`'s Linux-mode production build (`pnpm -C apps/desktop build`), unchanged, with Linux wording; its `--mode win` build (#3972) has the Windows wording and is the next one to run here. Host calls the pilot doesn't answer
resolve to `null` (and `engine.call`s outside the routes fail as unknown) and are logged once each as
`webui shell: unhandled host call …`; the shell starts, renders and navigates with them.

### Results

`scripts/windows/webui-pilot/run.ps1` drives the window with `SendInput` (real pointer and keys, in the console
session), reads state over CDP and Win32, and records the screen. Every check passed at both scales:

| Check | 100% (96 dpi) | 150% (144 dpi) |
| --- | --- | --- |
| Shared UI from `chrome://ardia/` in a frameless window, DWM shadow and rounded corners | yes | yes |
| `WM_NCHITTEST`: left, right, bottom, bottom-right outside the visible frame (native invisible borders) | 10, 11, 15, 17 | 10, 11, 15, 17 |
| `WM_NCHITTEST`: top edge inside the client area, through the shell's `Chrome_RenderWidgetHostHWND` | 12 (`HTTOP`) | 12 |
| `WM_NCHITTEST` over the shell's HTML maximize button | 9 (`HTMAXBUTTON`, via `HTTRANSPARENT` to the frame) | 9 |
| Snap layouts flyout on hovering the shell's maximize button | shown | shown |
| Typing an address in the shell, Enter: the page loads in the content area (`file:///…/form.html`) | yes | yes |
| Click into the page's input, type: the keys land in the page | yes | yes |
| Ctrl+L from the page: focus moves to the shell's field, the page keeps its text | yes | yes |
| Click back into the page and type: keys land in the page again | yes | yes |
| Resize from the right edge, the bottom-right corner, the top edge | yes | yes |
| Drag the window by the sidebar (`ArdiaShell.startWindowMove`) | moved 135,87 for a 140,90 drag | same |
| Drag to the screen's left edge: Aero Snap; drag out restores the size | yes | yes |
| Win+Left (left half, full height), Win+Right (back), Win+Up (maximized), Win+Down (restored) | yes | yes |
| Shell maximize button click toggles maximize | yes | yes |
| Close button: every engine process gone | 0.6 s | 0.6 s |
| Relaunch: the window comes back with the session's tab | yes | yes |
| A second launch while running raises the same window, no second window | yes | yes |
| Alt+F4 exits | yes | yes |

Proofs (screenshots, two 105 s recordings, logs) are in the PR.

Found on the way, and the fixes the desktop host needs too:

- **Tear the shell down while its views are alive.** With `CLIENT_OWNS_WIDGET`, `~ShellContents` freed its pass-through
  regions before `views::View` deleted the shell `WebView`, whose WebContents teardown reached `RetireRenderer` and
  wrote into the freed vector. The engine before `TearDown` crashed on 12 of 12 closes with pass-through regions active
  (`close.ps1`: exit `0x80000003` and a Crashpad dump each time, by `ArdiaShell.closeWindow` and by `WM_CLOSE`); with
  it, 12 of 12 exit 0 with no dump. The desktop host owns its widget the same way and needs the same order.
- **Running `install_static_unittests` on Windows** needs `icudtl.dat`, `dbghelp.dll`, `dbgcore.dll` and
  `msdia140.dll` beside it and a process at normal priority (a scheduled task's background priority fails its start
  check). Seven of Chromium's own `UserDataDir` tests fail there because they expect `Chromium\User Data` and the
  `Chromium` policy key, which Helium and `chromium-win-install-names.patch` rename; the `UserDataDir.ArdiaShell*`
  tests are the ones this change adds, and they pass.
- **Pass-through needs a root `WindowTargeter` on Windows.** The Linux model (shell `WebView` above the page
  `WebView`s, `WidgetDelegate::ShouldDescendIntoChildForEventHandling` skipping the shell where a page shows) was not
  enough: `Widget::ShouldDescendIntoChildForEventHandling` then compares view and window layers
  (`kNativeViewHostManagesLayers`), and clicks over the page landed on the widget's content window, reaching neither
  web contents. A targeter on the content window (`ShellRootTargeter`) that explores a page's window directly when the
  point is in a pass-through rectangle fixes it. The same applies to a `BrowserView`-hosted shell.
- **The shell's child window is the `WebContentsViewAura`, not a `NativeViewHost` container**, with
  `kNativeViewHostManagesLayers` on: Linux's `holder()->GetNativeViewContainer()` comparison never matches on Windows.
- **`<windowsx.h>` must not be included next to Views**: its `IsMinimized`/`IsMaximized` macros rename
  `Widget::IsMinimized` and break the link.
- **`ArdiaShell.setWindowTitle` renames the HWND** to the page title; tools must find the window by process and class.

### What compiled from the Linux host

`series_win.py` now copies these `engine/ardiacore-linux` files into the Windows tree at `//ardia/linux`, and
`//ardia/win` compiles them as they are. The list CI checks is `accepted-linux-sources.txt`; they are in the Windows
key's `key-inputs.json`, so a change to one moves the Windows key too:

| Linux file | Used as | What for |
| --- | --- | --- |
| `bootstrap.js` + `generate_bootstrap.py` | as is | the `chrome.send` bridge, `window.__ardiaHost` |
| `ac_linux_session.{h,cc}` | as is | `MergeLinuxSession` for `session.read`/`session.write` |
| `ac_desktop_routes.h` (from `engine/ardiacore-desktop`) | as is | generated `kRoutes` (37 routes): `engine.call` names to `ac_*` services |
| `ac_desktop_policy.h` (from `engine/ardiacore-desktop`) | as is | the shared `StoredRead` type (`kFound`/`kMissing`/`kFailed`) the document store answers with; the Windows rules are in `webui_policy.h`, not here: `ReadAsset` calls `ValidWindowsAssetPath`, and the document store calls `ValidWindowsDocumentName`, `ReservedWindowsDocumentName` and `WindowsDocumentLimit` |
| `ac_desktop_window_state.h` (from `engine/ardiacore-desktop`) | as is | `ArdiaShell.windowState`/`windowButtonLayout` names |

Rewritten for the pilot (each marks code the desktop host should own once, shared):

| Linux code | Windows pilot | Why |
| --- | --- | --- |
| `ShellHostView` inside `BrowserView` (`ac_linux_host.cc`, 8,921 lines) | `ShellHostView` inside `BrowserView` (`webui/webui_host_view.{h,cc}`, `webui_host_tabs.cc`, `webui_host_calls.cc`; #4112) | the pilot's single `ShellWindow` widget is gone: each Chromium browser window carries the shell over its own `BrowserView`, see "WebUI host on BrowserView" below |
| `ShellDataSource`, `ShellController`, `ShellConfig`, `ReadAsset`, `MimeType`, `AssetDirectory` | same code, copied | file-local in `ac_linux_host.cc`; move to `engine/ardiacore-desktop` as is |
| `ViewportTargeter`, `ShellTransparency`, `SubtractFromRegion`, `PassesShellPoint`, `DoesIntersectRect`, `SetInputRegions` | same logic, plus `ShellRootTargeter` | see Results |
| `HostMessageHandler` | `Handler` | same transport; the renderer-generation and lease bookkeeping is reduced to one window and generation `1` |
| `linux_window::StartCaptionMove` | `WM_SYSCOMMAND SC_MOVE \| HTCAPTION`, only while the left button is down | Win32 move loop, Aero Snap included |
| `chromium-linux-borderless-frame`, `-window-state` (GTK and Wayland frames) | `ShellTreeHost::GetClientAreaInsets`/`GetDwmFrameInsetsInPixels` + `ShellFrame::NonClientHitTest` + `WebUIShellPreTranslate` | Chrome's own Windows frame model: invisible native resize borders, top edge in the client, DWM shadow and rounded corners; `HTMAXBUTTON` presses are taken in the message pump and toggle maximize |

**WebUI host on BrowserView (#4112).** In `--ardia-shell=webui` the shell lives inside Chromium's own windows, as on
Linux. `InstallWebUIShellHooks` (`webui_shell.cc`, called from `BeforeWebUIChromeMain`) sets
`g_ardia_win_hosts_normal_windows` (no tab strip, toolbar, bookmark bar or Chromium shortcuts in a normal window),
`g_ardia_win_shell_frame` (`chromium-win-hosted-browser-windows.patch`: the window keeps the system DWM frame and its
contents stay transparent, so Mica and the rounded corners survive), `g_ardia_win_frame_view` (`ShellBrowserFrameView`
in `webui_frame.cc`: top-edge resize, `HTMAXBUTTON` over the shell's maximize button for Snap Layouts) and
`g_ardia_keeps_window_without_tabs` (a shell window and its companions stay open with no tabs until they close).

- `WindowRegistry` (`webui_windows.cc`) opens the `main` window at start, `ArdiaShell.openWindow` windows (browser,
  small, private, Settings, Import), and adopts any normal window Chromium opens by itself as `chromeMade`, its tabs
  offered as unclaimed. It tracks activation order (focus, links from other apps), private window ordinals
  (`ArdiaShell.privateWindows`), placement (`window-placement.txt`, the RNW format, cascaded 28 px from the window
  in front, fitted to the display's work area) and quits when the last browser window closes.
- `ShellHostView` (`webui_host_view.cc`) is a child view over the `BrowserView`: the `chrome://ardia/` shell
  `WebView` on top and one viewport `WebView` per shown tab under it. Tabs are real `TabStripModel` tabs created with
  `Navigate` (`kNewBackgroundTab`), so popups, `beforeunload`, session tab ids and tab helpers are Chromium's own. A
  tab of another profile lives in a hidden companion browser of that profile owned by the window (`EnsureMember`,
  `RouteProfile`); private and utility windows take no companions. The `BrowserView`'s own contents view is emptied
  after every strip change (`ReattachViewports`), and a page view Chromium took back is detached and reattached so a
  shown pane never stays blank. When Chromium replaces a tab's contents (a discard), the binding follows the new
  contents and the shell gets a `pageLifecycle` `rebind` whose lease carries the next `bindingGeneration`, not a
  close. `tab.presentations` also activates the
  presented tab in its native `TabStripModel`, so Chromium's active-tab services follow the shell.
- Closing: when companions hold tabs, the shell's close and the system's (`WM_CLOSE` from Alt+F4 or the taskbar,
  taken by `CaptionInput`) first run the companions' `beforeunload` while the visible window is still there to show
  their prompts (`ConfirmWindowUnload`, like Linux's `ConfirmCompanions`); the window's own tabs then go through
  Chromium's ordinary close, download warning included. A cancel resets the companions, and each new close attempt
  clears any confirmation a cancelled one left behind, so the next close asks again, and so does quitting
  (`ArdiaShell.quit`, closing the last window) through `ResetAllCompanionConfirmations`. `closing_` is set only when the
  widget actually starts closing (`OnWidgetClosing`), so a cancelled `beforeunload` never leaves documents refused.
  Companions closed after their window are emptied without prompts.
- A `session.write` broadcasts `ArdiaHost` `session` (`base`, `session`, `sourceWindowId`) to every non-private
  window, the writer getting its own base back, so Settings changes reach open windows at once. Entering and leaving
  full screen sends `ArdiaShell` `onWindowEvent` `{type: "fullScreen", id, on}`, and `minimizeWindow` takes a target
  window id. A window opens only for the live shell document that asked for it (`LiveFor`), on the display its
  requested, cascaded or saved frame falls on (`EffectivePlacementRect`). A closed window sends
  `onWindowEvent` `{type: "close", id}` to the other windows (a private one only to its opener). Chromium's "Open link
  in private window" becomes the shell's `openWindow` page event (`OffTheRecordNavigation`), and any other private
  window Chromium opens (say "Open link in new window" from a private window) is hidden at once and its pages go to the
  shell of the private window sharing its session, or else the front regular window, as `openWindow` requests, so the
  shell opens real private windows for them (`HandOverPrivateWindow`). A page no shell takes within 5 s moves into the
  same-session private window as an unclaimed tab; the empty Chromium window then closes.
- Host calls served there: `tab.create` (with `adoptId`, `previousClaim` and transfers between windows after
  `ArdiaTabs.prepareTransfer`), `tab.viewport`, `tab.presentations`, `tab.command` (`loadUrl`, `goBack`,
  `goForward`, `goToOffset`, `reload`, `forceReload`, `stopLoading`, `focus`, `blur`, `zoomStep`, `setMuted`,
  `close`, `navigationEntries`), `tab.release`, `tab.close`, `ArdiaTabs.unclaimedTabs` and the `unclaimed` event,
  `ArdiaTabs.claimLaunchTab`, `ArdiaShell.setActiveProfile`, `openWindow`, `focusWindow`, `windowIdentity`,
  `windowIds`, `privateWindows`, `toggleFullScreen`, `pickFolder`, `pickFiles`, `copyText`, `readText`,
  `listenForOpenURLs` with `onOpenURLs` (a second launch's URLs), `documents.watch`/`unwatch`/`commit`/`flush` with
  `documents.changed` (the shared `LinuxDocumentService` from `engine/ardiacore-linux`, compiled as is), and
  `profiles.loaded`; plus everything the pilot served (documents, session, telemetry, platform calls, routes).
- #4107's widened hooks are set in WebUI mode only (`InstallWebUIShellHooks`; the RNW host leaves them null):
  `g_ardia_linux_is_companion`, `g_ardia_linux_companion_owner` (a companion's tab-modal dialogs and permission
  prompts show in the visible window), `g_ardia_linux_present_companion` (a companion's `Show`/`Activate` focuses
  the owning window, its other window requests are dropped), `g_ardia_linux_window_tab_count` (one close warning
  for the window's tabs across its companions) and `g_ardia_linux_shell_passes_point` (`BrowserView` hands input at
  the shell's pass-through regions to the page below). Still deferred: the close drain
  (`g_ardia_linux_close_hooks`, `beginWindowCloseDrain`, `acknowledgeWindowClose`; until it lands
  `LinuxCloseHooksActive()` stays false and Chromium closes WebUI windows itself, running `beforeunload`),
  `ArdiaShell.beginDialog`, picture in picture, glass regions, notifications, idle signals, drag escape and switcher
  capture; none is advertised, so the desktop falls back as it does on a host without them.

**Compile probe** of the rest (`ARDIA_LINUX_COMPILE_PROBE=1`, objects only, nothing linked;
`docs/engine-build-windows.md`), on the Windows tree with the patches `series-win` takes (#4107, 2026-11-24): of the
118 `.cc` files, **81 compile on Windows as they are** and 37 don't (75 of 122 before #4107):

| Why | Files |
| --- | --- |
| POSIX headers (`poll.h`, `unistd.h`, `dirent.h`, `dlfcn.h`, `sys/*`) | 18: `automation`, `calendar_eds`, `cli`, `config_core`, `control_core`, `desktop_core`, `import_keyring`, `import_readers`, `import_storage`, `memory_pressure`, `power`, `secret_text`, `self_update`, `sync`, `sync_keystore`, `sync_vault`, `system`, `user_scripts_store` |
| POSIX types and calls (`uid_t`, `st_mtim`, `S_ISREG`, `mkdir`), mostly through `ac_linux_downloads.h` and `ac_linux_password_check.h` | 10: `downloads`, `file_drop`, `files`, `host`, `import_sessions`, `native_messaging`, `password_check`, `password_field`, `password_prompt`, `user_scripts` |
| D-Bus | 2: `geoclue`, `system_signals` |
| Needs a Linux-only copy or shim (`ac_test_media_route_provider.h` from `copies.tsv`, the `ac_engine_call` dlsym shim, the Rust core's `ardia/core_rs/include/ardia_core.h`) | 3: `cast`, `saved_history_engine`, `sync_keys` |
| `base::FileDescriptorWatcher` | 1: `config` |
| Other Linux-only APIs (`password_manager::kPasswordStore` switch, `GetAppOutput(argv)`, `ui::IndexFromPointFlags`) | 3: `credential_service`, `external_apps`, `typeahead_input` |

`base::FilePath` is UTF-16 on Windows, and no file fails for it any more: the 9 files that passed `value()` as a
`std::string` or built a path from one (`background_dialogs`, `import_service`, `live_service`, `profile_service`,
`report`, `site_controls_service`, `sync_service`, `download_service`, `extension_service`), and the path sites of
`config`, `credential_service` and `user_scripts`, go through `ardia/desktop/ac_desktop_paths.h`: `Text(path)` is
`value()` where paths are narrow (Linux, byte for byte, never through the locale as `AsUTF8Unsafe` would) and UTF-8
from `AsUTF8Unsafe` where they're wide, `FromText<base::FilePath>(text)` the reverse. `page_channel` and `web_store`
compile now that `chromium-linux-page-agent.patch` (its `ISOLATED_WORLD_ID_ARDIA_PAGE`) and
`chromium-linux-web-store-uninstall.patch` are on the Windows tree.

The 81 that compile include the documents service (`document_reducer`, `documents`, `document_schema`,
`document_service`), the page layer (`page_channel`, `page_lease`, `page_state`, `page_status`, `page_commands`,
`page_messages`, `page_media`, `page_prompts`, `page_evaluation`), prompts and dialogs (`dialogs`, `dialog_views`,
`permission_prompts`, `password_prompts`, `autofill_prompts`, `background_dialogs`), extensions (`extensions`,
`extension_views`, `extension_keybindings`, `extension_shortcuts`, `extension_service`, `web_store`),
`crash_dumps(_core)`, `report`, `notifications(_core)`, `close_hooks`, `devtools_authority`, the sync, import, live,
profile, download and site-controls services, `sync_crypto`, `sync_json`, `sync_wordlist`, `import_crypto`,
`import_formats`, `import_secrets`, `import_zen`, `glass`, `pip_player`, `profiles`, `site_controls`, `telemetry`,
`window_lifecycle`, `window_caption` and the rest. The hook globals most of them set are now declared on the Windows
tree by the patches `series-win` takes; linking them into `chrome.dll` is the BrowserView host's work.

### Moving a user's data from the RNW shell (#4043)

The cutover is an upgrade, so the WebUI host gets the React Native Windows shell's data by a one-time copy that
never changes the original. `packages/core-rs/crates/ardia-shell-migration` is the migration;
its `ardia-webui-migrate --from-rnw` binary runs it on demand, and the WebUI host (`--ardia-shell=webui`) invokes it
automatically at startup in `OpenWebUIShell` (`RunWebUIStartupMigration` in `webui_mode.cc`) before loading
`session.json` or `bootstrap.documents` whenever `ardia-webui-migrate.exe` is bundled beside `chrome.exe` and the
default user app-data folder is in use (or both `--ardia-migrate-from-rnw` and `--ardia-migrate-rnw-data=<dir>` are
passed for a scratch `ARDIA_DATA_DIR` run, with an `=`: Chromium's switch parser reads `--ardia-migrate-rnw-data <dir>`
as an empty switch followed by a stray argument; `--ardia-migrate-from-rnw` under `ARDIA_DATA_DIR` without a non-empty
`--ardia-migrate-rnw-data=<dir>` is refused like an incomplete migration, so the shell doesn't open; `--ardia-no-migrate` always disables it). The default Windows shell is still RNW.

| RNW keeps | at | WebUI gets | how |
| --- | --- | --- | --- |
| documents (`session.json` and the rest of `DocumentStore`), window placement | `%LOCALAPPDATA%\Ardia\<name>` | `%LOCALAPPDATA%\Ardia WebUI\<name>`, where the WebUI host already reads `session.json` | byte copy |
| config, hooks, themes | `%APPDATA%\Ardia\{config.json,hooks.json,themes\*.json}` (`<data>\config` with `ARDIA_DATA_DIR`) | `Ardia WebUI\config\…` | byte copy |
| sealed sync keys | `%LOCALAPPDATA%\Ardia\Sync\sync-key-<account>.dpapi`, DPAPI with entropy `ardia-sync-key/v1[/test-instance]/<account>` | `Ardia WebUI\Sync\sync-key-x<lowercase hex of the account>.dpapi`, the name and entropy the WebUI host's DPAPI secret store (`desktop_platform_win.cc`, #4039) reads | byte copy under the new name, only once the key unseals to 32 bytes for its own account |
| connected accounts | Credential Manager `Ardia Connected Accounts/<account>` (`… [<data dir>]/` with `ARDIA_DATA_DIR`): the first 2,560 bytes on the base item, comment `Ardia g<1|2> <chunks>`, the rest on `<base>#g<generation>#<n>` (`<base>#<n>` before generations), up to 64 chunks | `Ardia WebUI\Secrets\account-x<lowercase hex of the UTF-8 account>.dpapi`, DPAPI with entropy `ardia-connected-account/v1[/test-instance]/<account>`; the WebUI host has no connected-accounts store yet (`ArdiaKeychain` is refused on desktop), so the cutover's store reads this layout | reassembled as `CredentialStore::Get` does. RNW writes continuation chunks (no comment) before the base (comment `Ardia …`), each with the account as its `UserName`, so an item counts as a chunk only when it has no comment and a chunk-shaped name, and a chunk completes a secret only when its `UserName` and the base's are both exactly the account (blank owners never match); a chunk name two bases could both claim (`acct` generation 1 and legacy `acct#g1`) fails both. The namespace (`Ardia Connected Accounts [<dir>]/`) matches without case, as Credential Manager does, while the account keeps its case: one no base claims is an orphan of an interrupted first write and is left out (`credential_chunks_orphaned`), while a chunk-shaped name with its own comment is an account of its own. A missing chunk leaves the account out |
| Chromium's profile (cookies, saved passwords, extensions) and the install identity | `%LOCALAPPDATA%\Ardia\User Data`, the installer's registry | untouched and not copied | stays where it is |

Scratch files (`dialog.json`, `menu.json`, `activation.log`, `file-chooser.txt`, `Ardia.png`), dot files, staged
`.partial`/`.tmp` files and the folders beside the documents (`Logs`, `Telemetry`, `Crashpad` and the like) are left.

- **Rollback.** The RNW folders and Credential Manager items are only read (the vault interface has no write), so the
  RNW build opens exactly what it left. The tests compare every file's bytes and write time and the vault before and
  after, including after interrupted runs.
- **Restartable.** Each file is written to a `.<name>.<random>.rnw-migration.partial` beside it, flushed, then renamed;
  a later run removes its own leftovers (only `.ardia-mig-*.rnw-migration.partial`; other dot files stay). `rnw-migration.json`, the marker, is written last and only when every step finished;
  with it present (a whole finished report: version, run id, a finished outcome, every count) the migration doesn't
  run again, so what the WebUI host writes afterwards is never overwritten. A
  file the run finds already in place with the same content (for secrets, the same plaintext) counts as unchanged; one
  that differs (pilot data) is copied to `rnw-migration-kept\` before the RNW copy replaces it; a retry that finds a
  different pilot copy than the one kept keeps it too, as `<name>.<run>.kept`, named by a hash of its content, so an unchanged copy reuses its backup on every retry and a changed one gets its own (a different file already holding that name is never overwritten; the copy takes the next free name), and shortened with a hash of the name when that would pass 255 characters. An exclusive lock
  on `rnw-migration.lock` makes a second concurrent run answer `busy`. `migration.rs` stops before every rename in
  turn and resumes each to the same result as an uninterrupted run.
- **Safety.** Overlapping or relative folders are refused, and so is a root with a link or junction anywhere above it,
  or a linked marker or lock. Each root is reached by walking from the volume root one folder handle at a time, never by
  name, refusing any link or reparse point on the way (and creating missing folders on that chain for the WebUI
  root), and its handle's final path (`GetFinalPathNameByHandleW`, `F_GETPATH`, `/proc/self/fd`) is pinned. Every
  folder below it is opened relative to the folder handle above it (`openat`/`mkdirat` on Unix, `NtCreateFile` with `RootDirectory` and
  `FILE_OPEN_REPARSE_POINT` on Windows) and held while it's used, so swapping a folder for a link by name mid-run
  changes nothing: reads, staged files, listings (`fdopendir`; `GetFileInformationByHandleEx(FileFullDirectoryInfo)`),
  renames (`renameat`; `NtSetInformationFile` with `FileRenameInformationEx`, falling back to `FileRenameInformation`,
  on the open staged file with the held folder as `RootDirectory`, which the Win32 `SetFileInformationByHandle`
  refuses), deletes (`unlinkat`; `FileDispositionInformationEx` on a handle) and the lock all go through those
  handles, and every file read and the lock file must have exactly one link.
  Nothing is opened through a symlink, junction or other reparse point (`O_NOFOLLOW`, `FILE_FLAG_OPEN_REPARSE_POINT`)
  on either side, files with more than one link (`nNumberOfLinks`, `st_nlink`) and files over the
  limits (64 MiB documents, 4 MiB config, 64 KiB keys) are skipped, names follow the RNW stores' own rules, account
  file names are lowercase hex, DPAPI runs with `CRYPTPROTECT_UI_FORBIDDEN` and plaintext is read into one buffer of its exact size and zeroed. Staged files have short fixed names
  (`.ardia-mig-<pid>-<n>-<random>.rnw-migration.partial`), and accounts are at most 120 bytes so
  `account-x<hex>.dpapi` stays within NTFS's 255-character name. Boundary
  row `native:rnw-webui-migration`.
- **Report.** The report is committed before the marker, so a marker never exists without the report of its run; a
  report that can't be written fails the run (`failed_stage: report`), and a marker that can't be written replaces the
  success report with a `failed`/`marker` one. Each run writes `rnw-migration-attempt.json` with only an outcome (`migrated`, `migrated_with_skips`,
  `already_migrated`, `nothing_to_migrate`, `busy`, `refused`, `failed`), the failed stage (`layout`, `lock`,
  `documents`, `config`, `sync_keys`, `credentials`, `report`, `marker`), the attempt number, the
  duration and counts. The exit code is 0, 1 (failed, run again), 2 (refused), 3 (busy) or 64 (usage).
- **Telemetry.** Every event on Windows carries `host_shell` (`rnw` or `webui`, `state/telemetry/hostShell.*.ts`). On
  the WebUI host the telemetry leader loads the attempt report from disk with its own documents before the launch
  events read it, and sends `shell_migration` once per run only while sharing is on; the run is marked reported
  (`rnw-migration-reported.json`) only after the event went out and that mark is saved, so with sharing off it
  stays pending, and so it does when the event is dropped or throws (`capture` now says whether it queued the
  event, and a relay that drops it says so), and until the queue holding the event is saved to disk while the consent the launch started with is still the current one. It is reported
  only by the telemetry leader: on the desktop host, once the window has taken over from the startup relay (the
  leadership's after-lead hook), with the consent the launch started with, and at most once per run of the app. If the host can't store the mark, the next launch sends the run again: a duplicate, never a lost report. The desktop document and telemetry routes are live on both Linux and Windows WebUI (`webui_host_calls.cc` serves
`ArdiaShell.readDocument`/`writeDocument`/`saveDocument`/`removeDocument`, populates `bootstrap.documents`, and
advertises and handles `ArdiaTelemetry.post` using `ardia::desktop_telemetry_policy`), so
`rnw-migration-attempt.json` and `rnw-migration-reported.json` flow end-to-end into `shell_migration` telemetry. The event carries the outcome, `failed_stage`, `attempt`, `duration_ms`, `prior_failed_stage` and the counts: known enums
  and capped counts only. A failed attempt now quits before the report can be sent, so the next run copies the stage
  the previous failed attempt stopped at into its own report as `prior_failed_stage` (from that report's
  `failed_stage`, or the one it carried). A retry that succeeds still says where the one before it failed, and
  `attempt` still counts the tries. Both are carried only from a previous report that validates
  (`valid_attempt_report`: version 1, a 32-hex `run`, an outcome a report is written with, a numeric `attempt`);
  anything else starts over at attempt 1 with no prior stage. Watch
  `shell_migration` by outcome: `failed` and `refused` should stay near zero, and `credentials_incomplete` and
  `sync_keys_unreadable` against `credentials` and `sync_keys`.
- **Checks.** `tests/hostile.rs` runs the shared hostile corpus (`scripts/security/hostile-inputs.mjs`, read with node)
  as document, theme, sync-key and account names and checks the sink: nothing appears outside the WebUI folder, the
  RNW folder is unchanged, every file that lands matches the layout's own names, and a plain control migrates.
  `cargo test -p ardia-shell-migration` (Mac, Linux and Windows in `rust.yml`; on Windows also real DPAPI,
  a chunked account through Credential Manager, junctions on both sides and above a root, hard links and the WebUI
  sync-key name). In a Windows 11 guest,
  `scripts/windows/webui-pilot/upgrade.ps1 -Migrator <dir>\ardia-webui-migrate.exe [-RnwApp <RNW build>]` seeds a
  scratch RNW profile (documents, config, sealed keys, single, chunked, legacy and torn accounts, a fake Chromium
  profile), stops the migrator before each rename and resumes it (needs `Ardia.test-build` beside the migrator for
  `ARDIA_TEST_MIGRATION_STOP_AT_COMMIT`), checks every item, a second run, the RNW folder, vault and keys unchanged,
  the RNW build opening its folder again, the WebUI shell opening the migrated one, and refusals for overlap and a
  junction. It uses `ARDIA_DATA_DIR`-style scratch folders and removes the Credential Manager items it made.
  With `-RnwInstaller <Ardia-Setup.exe> -WebUIInstaller <Ardia-Setup.exe>` it also runs the installed upgrade
  described under "Packaging, installing and upgrading the WebUI shell".

### Packaging, installing and upgrading the WebUI shell (#4113)

The WebUI shell ships through the same Inno Setup installer as the React Native shell, from a folder that looks the
same to Windows: `Ardia.exe`, `chrome.dll` and the engine's files, with `ardia-ui\` and `ardia-webui-migrate.exe` in
place of `ArdiaApp.dll`. Since the cutover (#4142) it is the shell CI, releases and `windows-alpha` ship.

- **Assembly.** `assemble-webui.ps1 -Engine <engine> -Ui apps/desktop/dist/win -Out <dir> -MigrateBin
  <ardia-webui-migrate.exe> -UpdateVerify <ardia-update-verify.exe> -Shippable -Version <v> -Build <n>` renames `chrome.exe` to `Ardia.exe`, gives it Ardia's
  icon and name (`launcher-identity.ps1`, `-AppIcon` to use another `.ico`), adds the Visual C++ runtime the launcher
  and the migrator need (`vc-runtime.ps1`, `-VcRedist <folder>` to name the redist), checks the migrator and the
  update verifier are built for the launcher's CPU, copies the pinned `windows-update.pem` and stamps
  `Ardia.build.json`. It refuses to start without the migrator, the update verifier or a `-Build` above 0,
  with `-TestBuild`, or from an engine that carries an `Ardia.test-build` marker, and refuses to finish with
  `chrome.exe` or any React Native file left in the folder: a shippable folder never carries a test marker, and the
  tour marks a copy instead. `-LauncherName Ardia.exe` alone does the rename and the icon without the rest. Without
  these switches it assembles the pilot as before (`chrome.exe`, no rename); an engine's own `Ardia.test-build` is
  dropped unless `-TestBuild` asks for one.
- **One layout rule.** `scripts/windows/shell-layout.ps1` decides which shell a folder holds (`ArdiaApp.dll`: React
  Native; `ardia-ui\index.html`: WebUI; both or neither: refused), lists what an install of each ships, the
  commands it registers and what each shell owns: its own folders (`$ShellOwnedFolders`: `Bundle\`,
  `Microsoft.UI.Xaml\` and `NpuDetect\` for React Native, `ardia-ui\` for WebUI) and a fixed list of exact files
  (`$ShellOwned`, taken from the built React Native app: its library, WinUI and Windows App SDK files, the files with
  fixed names in its folders and the XAML `.mui` file in each locale folder; `ardia-ui\index.html` and the migrator
  for WebUI). It names what is wrong with a folder, including anything the other shell owns and, for the WebUI shell,
  a missing `Ardia.build.json`. `make-installer.ps1`, `installer-check.ps1`,
  `dependency-check.ps1`, `assemble-webui.ps1` and `upgrade.ps1` all read it, and `shell-layout.test.ps1` checks it
  with the assembler's and the installer's refusals.
- **Installer.** `make-installer.ps1` packages only a WebUI folder, and `Ardia.iss` is the WebUI shell's only. It adds `--ardia-shell=webui` to the Start Menu and desktop shortcuts, the
  launch after setup and the relaunch after an update, `"Ardia.exe" --ardia-shell=webui --single-argument %1` for
  `ArdiaHTM` and `"Ardia.exe" --ardia-shell=webui` for `StartMenuInternet\Ardia`. Switching shells removes only what
  the other shell shipped, and only once this shell is in place. `make-installer.ps1` writes a manifest of every
  file the payload ships in its shell's own folders and fixed list (`ardia-rnw-files.txt` or `ardia-webui-files.txt`,
  so every hashed `ardia-ui\assets\` file is named), which the install puts beside `Ardia.exe`, and hands the
  installer the other shell's fixed list as `retired-shell.txt` without installing it. At `ssInstall`, before
  anything is copied, the installer notes whether the other shell is there (its marker or its manifest) and reads
  this shell's own manifest from the last install. At `ssPostInstall`, after Inno has closed the app and copied every
  file, nothing happens unless this shell's marker (`ardia-ui\index.html` or `ArdiaApp.dll`) is now installed and the
  install folder isn't a link. Then an update of the same shell removes the files the last build's manifest listed
  and the new one doesn't (old hashed `ardia-ui\assets\` or `Bundle\` files), and a switch reads the other shell's
  manifest, or, for a React Native install from before manifests, the fixed list (the only place a `*\` entry is
  accepted; a manifest on disk takes exact paths, never `*` or `?`). Each file goes only if `GetFileAttributesW` shows
  no reparse point on the install folder, any folder on its path or the file itself, with `DeleteFile`; each emptied
  folder goes bottom up with `RemoveDir`, which leaves a folder holding anything else, or a link, alone. A file that is
  behind a link or can't be removed stays listed: in this shell's manifest after an update, or in the other shell's
  manifest, which is otherwise deleted, so a later install tries again. A file someone added in
  `Bundle\` or `ardia-ui\` stays, as does its folder, and an install that stops early leaves the old shell whole. So a
  WebUI install over the React Native one leaves no React Native file (an install from before manifests may keep
  `Bundle\assets\`, whose names change each build), and a rollback removes `ardia-ui\` and the migrator. User data is in `%LOCALAPPDATA%\Ardia` and `%LOCALAPPDATA%\Ardia WebUI`, never in the
  install folder, so neither step touches it. A WebUI install needs `Ardia.build.json`, as `installer-check.ps1` does.
- **Installer check.** `installer-check.ps1` checks the layout's own files (for the WebUI shell
  `ardia-ui\index.html` and `ardia-webui-migrate.exe`, and no `ArdiaApp.dll`), the Start Menu shortcut's target,
  arguments, icon and AppUserModelID, the registered commands with or without the switch, and that no
  `Ardia.test-build` was installed. It also seeds the React Native app's login item (`Run\Ardia`, no switch) with a
  disabled `StartupApproved\Run` value, clears `Run\Ardia WebUI` but leaves an orphaned enabled approval under it, and adds an item for
  `Ardia.exe` with extra arguments and an unrelated one. After the install the other shell's item and its approval
  are gone, this shell's item opens this shell's command with the disabled approval bytes, and the other two are
  untouched. A failed check still uninstalls (warning, never hiding the failure, if that fails too), and every value
  it touched is restored after the uninstall; the `StartupApproved\Run` key itself is left in place. The installer makes
  no `%LOCALAPPDATA%\Ardia\User Data`, so a WebUI install leaves no React Native folder behind.
- **Installed upgrade and rollback.** `upgrade.ps1 -RnwInstaller <rnw setup> -WebUIInstaller <webui setup>` (in a
  disposable Windows 11 account: it refuses to start when the user already has Ardia's uninstall entry, Start Menu
  shortcut, `StartMenuInternet\Ardia` or `ArdiaHTM` registration, an `%LOCALAPPDATA%\Ardia\User Data` folder (even
  empty) or an `Ardia WebUI` folder; `shell-layout.ps1` and `launcher-identity.ps1` sit beside it or one folder up) installs the React Native build silently into the run's own
  folder (`/DIR=`), runs the direct-migrator checks above against that install, then seeds a second profile sealed
  as a shipped build seals it (no `test-instance` in the DPAPI entropy: an installed build has no `Ardia.test-build`,
  so it isn't a test instance and passes no `--test-instance` to the migrator), runs the installed React Native
  build on it and closes it with `WM_CLOSE` (`installed-rnw-clean-exit`). It installs the WebUI build over it and
  checks the layout (no React Native file left), `Ardia.exe`'s identity, the uninstall entry and the shortcut. Every
  WebUI start passes `--user-data-dir=<data>\Chromium`, the folder the engine would otherwise relaunch into, so the
  process the harness started is the one that migrates and exits. It starts it twice so the migration must fail
  (`--ardia-migrate-from-rnw` without `--ardia-migrate-rnw-data`, and a junction at `Secrets`), expecting that
  process's exit code to be 75 with no window, no marker, no process left running from the install and the React
  Native profile and vault unchanged; then starts it with
  `--ardia-shell=webui --ardia-migrate-from-rnw --ardia-migrate-rnw-data=<profile>` and checks the window opens, the
  marker and the attempt report `shell_migration` sends (outcome, attempt, duration and counts, no paths or names),
  tabs, history, bookmarks, extensions, window placement, config, the sync key and every Credential Manager account,
  that cookies and logins stay behind, and that the React Native profile is unchanged. Last it reinstalls the React
  Native build (rollback), checks the layout is the React Native one again, runs it on the untouched profile and
  reads back every account and the sync key, and uninstalls. Before the forced failures it also updates the WebUI
  install with the same installer after adding a file only the last manifest lists, a manifest entry behind a junction
  and a file no manifest lists, and checks the first is removed, the junction's target and the third stay, and the
  junction entry stays listed (`same-shell-update-*`). Every process it starts is tracked by its id and creation time,
  and every stop, whether a run ends, a window closes or the run cleans up, goes through `Stop-VerifiedProcess`: right
  before stopping, the process must still have the same id and creation time and run from the install folder or the
  React Native build, and a tracked process's children count only when they started after it, so a reused process id
  is never stopped. Results go to `C:\pilot\proof\<label>-results.json`.
- **Tour.** `webui-pilot/tour-webui.ps1 -App <folder> -Out <dir>` tours a packaged WebUI build (`Ardia.exe` or
  `chrome.exe`, with `ardia-ui\` and an `Ardia.test-build` marker, which CDP needs) with real input and CDP:
  a clean launch, the window's icon and AppUserModelID (`SHGetPropertyStoreForWindow`, expected `Ardia.Browser`),
  a caption drag and back (within 16 px, with the whole window, its caption buttons included, on the 1024 by 768
  runner screen), a double-click on the top-most title bar region at the first unobstructed point inside the window
  and the screen (`data-ardia-drag="caption"`, which the desktop shim sets on every
  drag region whose double-click is the title bar action) to maximize and back, the `HTMAXBUTTON` hover and press states
  (`data-ardia-nc-hover`, `data-ardia-nc-pressed`, cleared when a press leaves the button) and a click on it,
  typing an address, Ctrl+T and Ctrl+Tab between two tabs, Ctrl+\ for a split pane (typed into only once the shell holds the keyboard, then a fresh page loaded in it and
  shown beside the one already there; a desktop shell text field's `focus()`, a field React focused for `autoFocus`
  before its ref attached, and a focus claim each ask a page to hand the keyboard to the shell, `tab.command` `blur`, when the shell document doesn't have it, and a handoff a newer one
  or another focus choice overtook never counts), Ctrl+, for Settings, a
  download from a page, a document written, read, found on disk and removed through `ArdiaShell`, a second
  `Ardia.exe --ardia-shell=webui --single-argument <address>` whose process exits while the running engine opens the
  address in Little Ardia (links from other apps open there by default), which the tour then closes, and Close on the
  main window with no process left running from the build's folder; the engine is stopped before the next launch either
  way. Then it starts `Ardia.exe` again with no
  `--ardia-shell` switch and checks the WebUI shell answers `ArdiaShell.windowIdentity`; that the browser's live
  DevTools port is the one in a WebUI profile's `DevToolsActivePort` (the run's `ARDIA_DATA_DIR\Chromium`, or
  `LOCALAPPDATA\Ardia WebUI\Chromium` when no relaunch moves it there, which Chromium writes only into the folder it
  opened), with its `Local State`, no React Native `Ardia\User Data` and no `--ardia-shell` on any process; and
  that the engine answers `ArdiaUpdates.status` with kind `portable` (`Ardia.build.json`, `ardia-update-verify.exe` and
  `windows-update.pem` beside the launcher, no uninstaller) and this build's `Ardia.build.json`. That launch points
  `LOCALAPPDATA` and `APPDATA` into the run's own folder, and runs only when the account has no `Ardia` or
  `Ardia WebUI` folder before the tour starts (every clean CI runner). Elsewhere the tour reports it as skipped,
  unless `-RequireFlagless` (as CI passes) makes that a failure. Handing an address to a running WebUI shell
  needs the Wave 5B-3b engine (#4118); since the cutover the tour gates the run, so the engine pinned in
  `prebuilt.json` must carry it. It writes `tour-webui-results.json` and `tour-webui.md` (each check,
  pass or fail, its time and detail). `lib.ps1` takes `PILOT_APP`, `PILOT_RUNS` and `PILOT_PROOF` so the tour also
  runs outside `C:\pilot`, finds `Ardia.exe` when there is no `chrome.exe`, and skips screenshots without ffmpeg.
  Its waits, log and argument quoting live in `webui-pilot/wait.ps1`: `Log` writes `steps.log` and the console but
  never the output stream, `Wait-Until -NoThrow` returns nothing on a timeout (so `[bool]` of it is `$false`) and
  names the last error a check threw, kept through later checks that come back false until one passes, and `wait.test.ps1` checks them and compiles every `Add-Type` in `lib.ps1`,
  `upgrade.ps1` and `tour-webui.ps1` with the default assemblies (PowerShell 7 drops them when
  `-ReferencedAssemblies` is given).
- **CI.** The `webui` (x64, `windows-latest`) and `webui-arm64` (`windows-11-arm`) jobs in `windows.yml` run the same
  steps on every Windows run, and are its only jobs besides `identity` and `source`: `shell-layout.test.ps1`,
  `pe-imports.test.ps1`, `update-verify.test.ps1` and `wait.test.ps1` on PowerShell 7 and Windows PowerShell (x64), `pnpm -C apps/desktop
  build:win`, `cargo build --release -p ardia-shell-migration --bin ardia-webui-migrate` (its cache keyed by the
  runner's CPU), the engine, `assemble-webui.ps1 -Shippable` and `dependency-check.ps1`. Full runs (`full-ci`, pushes
  to `main`, releases) also make `Ardia-Setup-<cpu>.exe`, install and uninstall it with
  `installer-check.ps1`, stamp it with `Ardia.build.json` (`release-files.ps1`) and, on x64, tour a copy
  of the build marked as a test build; a failed tour fails the run. Artifacts: `Ardia-Setup-<cpu>` (what
  `publish-alpha.sh <run id>` takes), `Ardia-windows-<cpu>`, `windows-release-<cpu>` when the run has a version, and
  `tour-webui`.
  `scripts/ci/windows-webui.test.mjs` keeps this wiring and the installer's WebUI default in place.
- **Cutover (#4142).** The release jobs take the WebUI installers, `assemble-webui.ps1` stamps `"shell": "webui"` in
  `Ardia.build.json`, and `publish-alpha.sh` refuses a build without that stamp (a build with none is a React Native
  one). #4143 then deleted the React Native shell, its CI jobs and its scripts. The upgrade path above is what existing installs
  take: the React Native app's updater runs the WebUI installer, which removes the React Native files and starts
  `Ardia.exe --ardia-shell=webui`, which migrates the user's data before its first window.

### Linux patches the pilot needed widened to Windows

None: the pilot runs in a plain `views::Widget`. It adds one Windows patch of its own,
`chromium-win-webui-user-data-dir.patch` (the profile folder, above). Hosting the shell in a
`BrowserView` as Linux does will need these, by what they touch:

| Patch | What it changes | For a BrowserView-hosted shell on Windows |
| --- | --- | --- |
| `chromium-ardia-linux-layer` | links the layer into `chrome`, calls it from `chrome_browser_main` and `chrome_main_delegate` | widen, or keep using `//ardia/win`'s existing `g_ardia_win_add_main_parts` hook (the pilot does) |
| `chromium-linux-shell-above-input` | `BrowserView::ShouldDescendIntoChildForEventHandling` asks the host | widen as is (no Linux API); the pilot's widget delegate does the same |
| `chromium-linux-background-windows`, `-companion-browsers`, `-window-minimum-size` | hidden companion browsers that hold a profile's tabs, minimum size | widen as is (Views and browser code) |
| `chromium-linux-document-close` | defers browser close until the shell has sealed its documents | widen as is |
| `chromium-linux-page-agent`, `-page-prompts`, `-page-status`, `-wheel-zoom`, `-unhandled-key`, `-private-links`, `-navigation-hold-hook`, `-autoplay-policy`, `-geolocation` | page channel, prompts drawn by the shell, status, zoom, keys, private links, autoplay | widen; the Windows autoplay patch (`chromium-win-autoplay-policy`, Blink commit parameter) is the one to keep |
| `chromium-linux-devtools-authority`, `-devtools-open-tab` | devtools as tabs the shell owns | widen; `chromium-win-devtools-other-clients` overlaps |
| `chromium-linux-auto-pip`, `-pip-placement`, `-pip-in-window`, `-media-player-pip` | picture in picture inside the window | widen as is |
| `chromium-linux-action-popup-hook`, `-extension-keybindings`, `-settings-overrides`, `-web-store-uninstall` | extensions UI through the shell | widen; `-settings-overrides` touches a manifest feature list |
| `chromium-linux-open-urls` | links from other apps reach the running shell | Windows has `g_ardia_win_relaunched` already (the pilot uses it) |
| `chromium-linux-thin-scroll-bars`, `-glass-compositing` | overlay scroll bars, a transparent compositor for glass | widen `-thin-scroll-bars`; glass is DWM Mica on Windows instead |
| `chromium-linux-frameless-utility-windows` | frameless settings and import windows | Windows: the same `ShellTreeHost`/`ShellFrame` the pilot uses |
| `chromium-linux-window-state`, `-borderless-frame` | GTK and Wayland frame, tiling and decorations | Linux only; replaced by the pilot's DWM frame model |
| `chromium-linux-native-messaging-hosts`, `-branding`, `-wayland-cursor-fallback`, `helium-branding-linux` | POSIX paths, Linux branding, Wayland | Linux only |

### Blockers

None fundamental. Views on Windows hosts the WebUI shell, a page below it, native resize and snap, and the snap
layouts flyout over an HTML button. Closed in #4087:

- **`HTMAXBUTTON` hover and press state:** `CaptionInput::PreTranslate` (`webui_frame.cc`) tracks `WM_NCMOUSEMOVE`, `WM_NCMOUSELEAVE`
  (armed via `TrackMouseEvent` with `TME_NONCLIENT | TME_LEAVE`), `WM_NCLBUTTONDOWN`, `WM_NCLBUTTONUP`, and clears
  state on client input, capture loss, cancel mode, or deactivation in both `PreTranslate` and
  `CaptionInput::FilterMessage` (an `HWNDSubclass` filter on the browser window, which sees the sent
  `WM_CAPTURECHANGED`, `WM_CANCELMODE` and `WM_ACTIVATE`) via `MaximizeButtonStateMachine`,
  emitting `ArdiaShell.maximizeButtonState` (`{ windowId, hovered, pressed }`) to `apps/desktop/src/maximizeButtonState.ts`
  and `WindowControls.tsx` for immediate hover/active styling alongside Snap Layouts.
- **Final-path root and file containment:** the root folder and the files in it are opened differently.
  `ReadAsset` (on `ardia-ui\`) and the document store (on the WebUI app-data folder: `readDocument`, `writeDocument`,
  `removeDocument` and `bootstrap.documents`) open the root with `OpenDirectoryFinalPath(directory, true)`, which
  follows a reparse point: the root itself may be a junction or another redirect, and its canonical final path from
  `GetFinalPathNameByHandleW` is what files are checked against. Every asset or document file is then opened with
  `FILE_FLAG_OPEN_REPARSE_POINT`, must be a single-link regular disk file that is not a reparse point
  (`nNumberOfLinks == 1`), and its own final path must sit inside that canonical root (`IsStrictlyWithinWinDirectory` for
  assets, `IsDirectChildOfWinDirectory` for documents). Both paths come from `GetFinalPathNameByHandleW`, which spells
  every folder in its on-disk case, so `WinFinalPathStartsWith` folds case only in the drive letter, the UNC server
  and share, or the volume GUID, and compares every folder after that exactly: a case-sensitive NTFS folder whose name
  differs only in case is outside. So a junction or symlink below the root that points outside is
  refused (`asset-junction-escape-refused` in `junction.ps1`, with a CSP-allowed image control;
  `documents-refuse-reparse-point` in `bridge.ps1`), while a root that is itself a junction works
  (`documents-read-under-junction-app-data-root` in `junction.ps1`: `Ardia WebUI` is a junction in the default layout,
  where the test gate keeps CDP closed, so the check seeds two documents in the junction's target and reads the
  shell's `bootstrap documents: <n>` log line: the 2 seeded plus the engine's own `launch-guard.json`, 0 when the root
  is refused). `asset-sink-refuses-hostile-corpus` sends every value of the shared hostile corpus to
  `chrome://ardia/<value>`, raw and URL-encoded, and checks each request on its own against the test-only
  `ArdiaShell.testAssetSink` counters (`served`, `refused`, `outsideRoot`, `unreadable`, counted only in a test
  instance). A same-origin request must move exactly one counter and never `served` or `outsideRoot`, a request the
  URL resolves to another origin (stopped by CSP) must move none, and a value the URL parser resolves to the shell
  page itself is counted and not sent, so a skipped or misrouted probe can't hide behind another's refusal. Every image
  must fail; the PNG control raises `served` by one and the junction escape raises `outsideRoot` by one. Those checks don't show that the root can't be
  redirected: whoever can re-point the root already owns the folder. A root re-pointed between opening the root and
  opening a file fails the containment check.

Remaining open points:

- **Private pages and private `engine.call`s are refused** in the pilot (a private page would trip
  `ScopedProfileKeepAlive`'s check on an off-the-record profile).
- **Pages are bare `WebContents`.** No tab helpers, `TabStripModel`, dialogs, permission prompts, downloads, popups or
  devtools: that is what the companion-browser model of the Linux host (and its patches) gives.

### Remaining work for the full desktop host

In order, as the next PRs:

1. `engine/ardiacore-desktop` with the platform-neutral half: the 75 Linux files that compile, plus the data source,
   WebUI config, bridge, viewports and input regions out of `ac_linux_host.cc`, and `ShellRootTargeter`
   (selector sets in `series_win.py` and the key tooling first, Track 2).
2. The POSIX seams behind `ac_desktop_platform.h`: files and folders (`dirent`, `mkdir`, `stat`), process and pipe I/O
   (`poll`, `GetAppOutput`), memory locking (`mman`) and file watching (`inotify` → `ReadDirectoryChangesW`), `uid_t`
   checks (Windows ACLs). Windows delegates for secrets (DPAPI), calendar, location, power, idle and session signals in
   place of D-Bus, libsecret and EDS. `FilePath` UTF-16 is done (#4107, above).
3. Widen to `IS_LINUX || IS_WIN` the Views and browser patches in the table, then host the shell in a `BrowserView`
   with companion browsers as Linux does, keeping `ShellTreeHost`/`ShellFrame` as the Windows frame. The patches are on
   the Windows tree since #4107 ([below](#the-linux-patches-windows-takes-4107)); what's left is the host and the
   guards that change behavior, which it turns on behind the WebUI shell.
4. The host calls the pilot stubs (logged as `unhandled host call` at start: `ArdiaShell.readDocument`/`writeDocument`,
   `setActiveProfile`, `openWindow`, `setMenuBookmarks`, `setMenuState`, `shellPainted`, `ArdiaTabs.unclaimedTabs`/
   `claimLaunchTab`, `tab.presentations`, `tab.command` `setMuted`/`evaluate`/`capturePicture`, and the `engine.call`s
   `documents.watch`, `profiles.loaded`, `engine.info`, `downloads.list`, `engine.memorySaver`, `engine.systemState`,
   `tabs.strips`, `search.setEngineName`, `webView.*`, `webKit.setFraudWarnings`, `profiles.ctrlTabMru`), then Track 3's
   generated routes so the list stops being hand-kept.
5. Windows wording (`--mode win`, `.win.ts`), Mica, the installer and the upgrade migration (Track 4's cutover), and a
   CI job that runs `run.ps1`'s checks plus the Linux acceptance tour over CDP.

Two RNW features the desktop host must carry over:

1. **Crash reports** (#2442): the RNW app reads Crashpad minidumps itself (`apps/browser/windows/Ardia/CrashDumps.h`,
   native API v25). On the desktop host this is `ac_linux_crash_dumps(_core)`, which compiles on Windows: it lists and
   reads Chromium's own Crashpad database (`chrome::DIR_CRASH_DUMPS`, `<User Data>\Crashpad` on Windows, through
   `crashpad::CrashReportDatabase`, so the `reports\<uuid>.dmp` layout and its metadata are Crashpad's) and hands the
   dump's bytes to `ArdiaCrash.read`. The dump reader is `apps/desktop/src/hostCrashReports.ts`: a dump whose system info
   says Windows (`PlatformId` 2) becomes a `WIN32_EXCEPTION` report as RNW's does: the NTSTATUS name (RNW's table,
   `STATUS_<hex>` otherwise), `ACCESS_READ`/`WRITE`/`EXECUTE` for access and in-page faults, one frame from the
   exception address, and only a module file name RNW would also send (`.dll`, `.exe` and the like; never a folder,
   a UNC path or a URL). Which reader runs is the build's, never the dump's: `@platform/crashPlatform` says what
   `SystemInfo` platform the host expects (Linux `0x8201`, Windows 2), and a dump without system info or naming
   another platform isn't reported. Both readers keep only what follows the last `/` or `\`, strings over 4 KiB
   aren't decoded, and a module list whose count runs past its stream's declared size is dropped.
   `hostCrashReports.test.mjs` covers both readers and those malformed dumps.
2. **Report a Problem** (#3666): Windows has no native uploader today. `ac_desktop_report_core` and `ac_linux_report`
   compile on Windows (#4107): paths are UTF-8 through `ac_desktop_paths.h`, `InsideDrafts` takes the native separator
   (a drive root and `\` on Windows, where it also refuses `/`, `:` streams and segments ending in `.` or a space,
   which Windows strips, and folds only the drive letter's case), and `0700` on the drafts folder is POSIX only (the
   profile folder's ACL already keeps it the user's). On Windows `_wfullpath` resolves no junction, so every path is
   checked through an opened handle: the drafts folder and the target and its parent resolve with
   `GetFinalPathNameByHandleW` (`DosFinalPath` refuses UNC and volume-GUID forms), the target and its parent are opened
   with `FILE_FLAG_OPEN_REPARSE_POINT` and refused when they are reparse points, an output is created with
   `CREATE_NEW` on such a handle (after removing a regular file there) and checked inside the drafts folder before a
   byte is written, and an input's open handle is checked the same way. The checked handle is what the operation
   uses: a replaced output and a removed gzip source or failed output are deleted through their own handles
   (`FileDispositionInfo`), removing a draft walks it under held folder handles that deny delete sharing and deletes
   each entry through its handle (a link inside is deleted as a link, never followed), and an upload reads its bytes
   from the verified handle (within the file's size cap) and sends them as the request body, so nothing reopens the
   path. A gzip refuses a destination that is its
   source by file identity (volume serial and file index on Windows, `st_dev`/`st_ino` on POSIX), not by path text,
   which a case alias or a hard link would pass. The password export (`PlanExport`) takes the native separator too,
   so a Windows drive-rooted destination reaches `ac_passwords_export`, which `ardia-layer-win.patch` already reads
   with `FilePath::IsAbsolute`. `apps/desktop` joins a Windows draft folder
   and its file with `\` (`draftFilePath`). `report_core_test.cc` and `hostReport.test.mjs` cover the Windows paths.

### The Linux patches Windows takes (#4107)

`series.py` still refuses a platform set (`linux,win`), and teaching it one moves every key, the Mac's included, so
`series-win` names each patch with a `take` line instead: Windows applies that `linux` line at its own place in the
shared series, as a `linux,win` line will. A `take` line changes nothing for the Mac or Linux. The Linux engine key
does move, for the launch-config split, the widened and gated patches and the changed Linux layer sources
(`c6e339147f82` on main, `eb14e4729781` here), so Linux needs a new engine; the macOS key is byte for byte
`origin/main`'s. On the Windows tree (MSI, 2026-11-24) all 24 apply with `git apply`, no
fuzz, and `chromium-win-ardia-layer-calls-mac-only`, `-external-protocol-dialog`, `-hosted-popups-and-menus` and
`-hosted-theme-change` are remade on top of them, so 132 of the 133 patches apply strictly (the one with fuzz is the
`mac` line `chromium-safe-storage-one-key-for-every-data-dir`). The 35 Chromium files they touch pass `clang-cl
-fsyntax-only` with their targets' flags.

Nothing changes for the React Native Windows shell. A taken hook is a null pointer (or a `false` flag) until the
desktop host sets it, which only the WebUI shell will. Guards that would change behavior on their own stay
`IS_LINUX`, so Windows compiles stock code there:

| Patch | On Windows |
| --- | --- |
| `-private-links`, `-navigation-hold-hook`, `-devtools-open-tab`, `-pip-in-window`, `-web-store-uninstall`, `-media-player-pip`, `-geolocation`, `-document-close` (its GN deps) | guards widened to `IS_LINUX \|\| IS_WIN` (`is_linux \|\| is_win`); null hooks, so stock until set |
| `-page-agent` | the browser-side binder and `ISOLATED_WORLD_ID_ARDIA_PAGE` widened; the renderer agent (`//ardia/linux:page_agent`) stays Linux until Windows builds it |
| `-shell-above-input`, `-companion-browsers`, `-window-minimum-size`, `-page-prompts`, `-page-status`, `-wheel-zoom`, `-unhandled-key`, `-action-popup-hook`, `-thin-scroll-bars` | no guards: null hooks |
| `-background-windows` | taken without its launch-config half, now `chromium-linux-launch-config.patch` (`linux`); its `--ardia-background` check stays Linux |
| `-auto-pip` | hooks taken; the feature switches it adds in `BasicStartupComplete` stay Linux |
| `-document-close` | every path it changes asks `ardia::LinuxCloseHooksActive()`: always true on Linux, true on Windows only once a host sets `g_ardia_linux_close_hooks.defer`. Until then none of its Linux close code runs: `BrowserCloseManager` runs Chromium's own bodies (no deferred success callback, no confirmed-browser rescan, Chromium's own downloads callback), `UnloadController` registers no close client, builds no close continuation, touches no pending-unload map or close flag and keeps Chromium's state transitions and repeat `OnWindowCloseComplete`, and `RenderFrameHostImpl` starts no close dispatch for any `beforeunload`, navigations included, and posts Chromium's own ACK |
| `-pip-placement`, `-extension-keybindings`, `-settings-overrides`, `-devtools-authority` | guards stay Linux: they call Linux layer code or change behavior unconditionally; taken so the files match Linux's and the patches after them apply. `-devtools-authority` and `chromium-win-devtools-other-clients` share no file |

`linux-hooks.gn` gives Windows `//ardia/linux:close_hooks` (`ac_linux_close_hooks.cc`, which `-document-close`
links) and the `ac_linux_content_hooks.h` header
`-media-player-pip` includes. `chromium-win-autoplay-policy.patch` stays Windows' autoplay patch and
`-autoplay-policy` stays Linux, and so do `-window-state`, `-borderless-frame`, `-glass-compositing`,
`-frameless-utility-windows`, `-open-urls`, `-native-messaging-hosts`, `-branding`, `-wayland-cursor-fallback`,
`chromium-helium-branding-linux` and `chromium-ardia-linux-layer`.


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
