# Ardia for phones (Expo)

One Expo app for both phones, replacing the SwiftUI iPhone app and the Compose Android app (issue #1556). On this
branch the old Android app is gone ("The old Android app, cleaned out" below); `main` keeps it until the merge.
Screens, app state and the data store are TypeScript; what has to be native is an Expo module wrapping the Kotlin and
Swift code that already exists. Both phones run it: Android and the iPhone.

## Layout

```
apps/phone/                 the app, and the root of its own pnpm workspace with packages/phone: Expo 58, React
                            Native 0.88.1, React 19.3, Reanimated 4.7, Worklets 0.13, Gesture Handler 3.3, Hermes V1
  android/                  the Android project, checked in (application id com.ardia.browser.android, minSdk 29,
                            arm64-v8a and x86_64)
  src/                      the Mac's folder rules (docs/conventions.md): components/ui, components/<feature>,
                            state/<domain>, platform, lib
  ios/                      the iPhone and iPad project, checked in (bundle id com.ardia.browser.ios, the SwiftUI
                            app's, iOS 27, React Native's prebuilt core)
  scripts/gradle-locked     Gradle under one lock, so one Android build runs at a time
packages/phone/             @ardia/phone-native, the Expo module package
  src/                      the TypeScript side: PageView and its types
  android/                  the Kotlin side: the module (com.ardia.phone) and the engine it owns, the page engine
                            (com.ardia.browser), content blocking, the script runtime and sync, with their tests
  ios/                      the Swift side, pod ArdiaPhoneNative. It builds against ArdiaKit's ArdiaBrowser, so the
                            SwiftUI app and this app run one WebEngine and WebTab
```

`@ardia/core` is imported straight from `src/mobile.ts`; no bundle, no script engine.

The phone is its own pnpm workspace, apart from the Mac's, so the two apps can run different Expo and React Native
versions (decided 2026-11-15 for the move to Expo 58 and React Native 0.88, which the Mac can't follow: Expo 58 has no
macOS and react-native-macos stops at 0.83):
- `apps/phone/pnpm-workspace.yaml` holds `apps/phone` and `packages/phone`, with its own `pnpm-lock.yaml` and a
  hoisted `apps/phone/node_modules`. `@ardia/core` comes in as `link:../../packages/core`; it imports only `node:`
  modules. The root workspace leaves both out. Install with `scripts/agent/locked pod -- pnpm -C apps/phone install`.
- Nothing of the Mac's is on the phone's resolution path. Metro reads only `apps/phone/node_modules` and watches
  `packages/phone` and `packages/core`. TypeScript keeps symlinks (`preserveSymlinks` in the three tsconfigs), so
  `packages/phone` is read through `apps/phone/node_modules/@ardia/phone-native` and its imports find the phone's
  modules; tests import it by that name, never by a relative path. `customConditions: ["react-native"]` and
  `moduleSuffixes: [".native", ""]` resolve types as Metro resolves code. Jest's `test/render/resolver.js` resolves a
  bare import from `packages/phone` as if from `apps/phone`, through Reanimated's own jest resolver.
- Why not one workspace: with the hoisted linker one copy of `react-native` and `expo-modules-core` sits at the root,
  and whichever version pnpm picks is what `packages/phone` (whose React Native is a peer) and Expo's autolinking see.
  A Mac dependency change could flip it, and one install rewrote both apps' trees.

## The page view

`PageView` (`packages/phone/src`) is the page. Android backs it with `PageEngine` (`com.ardia.browser` in `packages/phone/android`)
(`DevelopmentWebViewEngine` over the system WebView today). The iPhone backs it with `WebEngine` and `WebTab` from
`packages/phone/ios/ArdiaKit` (WKWebView with the SwiftUI app's content blocking, popups, downloads and page requests),
in an in-memory tab store until this app takes over the SwiftUI app's data. Its tone is `PageTone.resolve` and
`ToneSampler` in ArdiaBrowser, the code the SwiftUI app's bar uses. The page takes iOS's edge swipes for back and
forward.

- Props: `pageId` (a page lives in the native engine under this id and survives remounts), `initialUrl` (loaded when
  the page is first opened), `toneInsets` (dp at the top and bottom to leave out when sampling the page's tone).
- Events: `onPageState` (`url`, `title`, `progress`, `isLoading`, `canGoBack`, `canGoForward`) and `onPageTone`
  (`top`, `bottom` as `#RRGGBB`, already resolved from theme colour, background colour and the sampled bands). Native
  sends both on one `onPageEvent` channel; the wrapper splits them.
- Handle: `loadUrl`, `goBack`, `goForward`, `reload`, `stopLoading`. `closePage(pageId)` ends a page.

**What the Codex review of 15 November changed** (Android).
- A page's picture is published by generation (`<stem>-<generation>-WxH.jpg`), so a newer capture always wins. Its
  decoded bitmap stays pinned in Fresco's cache under the file's URI until the JPEG lands, then
  `page.snapshotLanded` announces it. The tab's saved row keeps the last durable URI until then (fb35ea88d native,
  ddb3463ad JS).
- A closed page's pictures are cleaned up by the page's lifetime, not its id, so a reopened id never loses a live
  page's files (fb35ea88d).
- Android's camera, microphone or location dialog is raised only for the page on screen (activity resumed, page
  view at least half visible), one at a time, and a closed page's ask is dropped. An ask lost to activity
  recreation or a JS reload is asked again: the first answer wins, and one granted in the meantime skips the dialog.
  An unanswered request is sent again when JS reopens a page it was already watching (07fca2a67).

**Night Shade's timing on Android.** `night-shade.js` is added with `addDocumentStartJavaScript`, with the state for the
page's host baked in: `WebViewPage` removes the old script and adds one carrying the host, the mode and the site's
cached verdict (`light`: shade it, `dark`: it has its own dark look, or `unknown`) before each main-frame navigation
(`prepareNavigation`, which `loadUrl`, reload, back and forward, restores, and renderer navigations and redirects
through `shouldOverrideUrlLoading` all call), again in `onPageStarted`, when a site's verdict changes and when site
settings change. The script trusts the baked state only when its host matches `location.hostname`; otherwise (a POST,
a popup, a WebView without `DOCUMENT_START_SCRIPT`, which runs it at `onPageStarted`) it asks native over the
`ardiaPage` listener at document start, which answers `"<mode> <verdict>"`. With the mode on (Always, or Automatic
while the page sees a dark scheme) and the verdict `light`, the `#ardia-night-shade` style goes in as soon as `<html>`
exists (a `MutationObserver` on the document), before any of the page's scripts and before the first paint. With no
verdict, the page is measured when `<body>` exists (left alone while it has no background and stylesheets are still
loading, as on iPhone) and again as each stylesheet loads, then at `DOMContentLoaded` and `load`. A cached verdict holds
until `DOMContentLoaded`, then is measured again there and at `load`, so a redesigned site is corrected. When a
measurement from `DOMContentLoaded` on differs from what the page was given, the script posts
`nightShadeVerdict:light|dark` (accepted from the main frame only, keyed by its origin's host). `NightShadeVerdicts`
keeps it: for regular tabs in the site preferences (`nightShade.verdicts`, at most 400 hosts, the least recently used
dropped first, a use saved at most once a minute), for private tabs in memory until private browsing ends. Clear
Browsing Data with History forgets the verdicts used in its range (`forgetNightShadeVerdicts`). The iPhone does the
same in `WebEngine` and `NightShadeVerdicts.swift`; the measurement and the style are the same text on both
(`PageScriptsTest`). Tests: `NightShadeVerdictsTest` (cap, order, private, clearing), `PageScriptsTest` (the baked
script and the messages) and the device test `NightShadeStartTest` (an inline script at the top of `<body>` sees the
style on a second load of a light site, typed, reloaded or followed from a script; a dark site is learned and left
alone; a site that turned dark is corrected; Night Shade off shades nothing).

`browser`'s `Omnibox.kt` (the ScriptEngine bridge) and `PageSurface.kt` (Compose) are left out of the module's build:
the Expo app calls `@ardia/core` itself and hosts the page's view natively.

## Sync on Android

Sync is a native subsystem with its own script runtime; the app's JavaScript never sees the host functions,
keys, the phrase's entropy or sealed bytes. `@ardia/phone-native` holds the sync engine (`com.ardia.sync`) and its
script runtime (`com.ardia.shared`, `ardia_hermes.cpp`), and `ArdiaPhoneSync` (`packages/phone/src/sync.ts`) wraps `SyncController` whole:
status and the synced view as getters and events, connect and change folder with the system folder picker, sync
now, stop, the reset notice, device name, profile, send, pin to Mac, incoming sends. One controller owns every
cycle on its own thread; `MainApplication` is the `SyncControllerOwner`, so WorkManager's `SyncWorker` (every 15
minutes, and a flush after the app leaves the screen) runs it without React Native.

- **Runtime.** `ardia_hermes.cpp` builds against React Native 0.88's prefab Hermes V1 (`hermes-engine::hermesvm`),
  JSI and fbjni, the same Hermes line the Compose app ships (260318099.0.5), so the process has one Hermes and
  sync gets its own runtime instance. `libardiahermes.so` needs only the `libhermesvm.so`, `libjsi.so` and
  `libfbjni.so` the app ships. A store build defines `ARDIA_SCRIPT_QUIET`, so the sync script's `__log` writes
  nothing to logcat; a lab build logs it as `ArdiaJS`.
- **Bytecode.** `CompileSyncBundle` (`packages/phone/android/build.gradle`) compiles `ardia-sync.js` as it is, with
  `hermes-compiler`'s `hermesc` and `-Xes6-block-scoping`, as the Compose app does. It refuses to run unless
  `hermes-compiler` and React Native's Hermes (`sdks/hermes-engine/version.properties`) are both 260318099.0.5 and
  the `hermesc` binary matches its pinned sha256, so the bytecode always matches the runtime that loads it. The
  whole companion suite (`packages/sync/src/companion`) runs against the bundle first. Under React Native 0.81 the
  bundle went through Babel's class, block-scoping and async transforms because that Hermes rejected them; Hermes V1
  runs them natively, so the Babel step and its pins are gone. A lab build also compiles the runtime checks
  (`sync-runtime-checks.js`) and the results Node gives for them, which the lab compares with Hermes V1's on the phone.
- **The phone's data.** Sync reads the app's `browser.db` (`filesDir/SQLite`, written by expo-sqlite) read-only
  on its own thread: open web tabs, the 30 newest per profile, and visits grouped by address and profile. A
  missing database is an empty phone; one that cannot be read fails the cycle. The app never writes private
  tabs or their visits to it. Its tables are the Kotlin store's: `tabs`, `tab_state` and `visits` have the
  same columns and indexes, `PRAGMA user_version` is 1 in both and both use WAL. The differences: the Expo
  file adds a `preferences` table (the Kotlin app keeps preferences in SharedPreferences), Android's
  `SQLiteOpenHelper` adds `android_metadata` to the Kotlin file, and nothing marks a row as private in either
  file (the Kotlin app keeps private tabs in memory, the Expo app never writes them). The Kotlin `store`
  module's readers are not reused: `BrowserDatabase` opens the file to write and migrate, and `TabStore`
  answers sync from its in-memory state.
- **Sync's writes to the phone's data.** Tabs a Mac sent and history a Mac removed go to an inbox file next to
  the sync state (`noBackupFilesDir/PhoneSync`), written whole and renamed into place, until the app applies
  them to its store (`sync.inbox()`, `sync.inboxApplied(ids)`, the `sync.inbox` event). Visits waiting to be
  removed are left out of what sync reads, so they never go back to the Mac.
- **One SQLite engine for `browser.db`.** expo-sqlite bundles its own SQLite (`exsqlite3_*`) and the app's JS keeps
  `browser.db` open through it, so native code reads the file through that same engine: on iPhone
  `SQLiteEngine.expoSQLite` (sync's `PhoneBrowsingSource`, Spotlight and Shortcuts' `TabRecords`), on Android
  `ExpoSqliteBrowserRows` over `ExpoSqliteConnection`. A second engine in the process can't see the first one's file
  locks: it resets the WAL index the first has mapped and the app dies with SIGBUS (the iPhone crash on reopening the
  app, 0.2.47 and 1.0.1). `apps/phone/scripts/one-sqlite-engine.test.mjs` fails on any other use of the system SQLite.
- **Lab.** The page lab's Sync button connects with a typed phrase and a picked folder and shows the status and
  the synced view's counts. Runtime checks runs semantic fixtures (closures in loops, microtask order around a
  host call, sort stability, Map and Set order, large integers, string comparison) in a second sync runtime and
  prints `PAGELAB PASS` or `PAGELAB FAIL` per check against Node's results from the build.

#### Sync tester script (lab build, a Mac with sync on)

Watch `adb logcat -s PAGELAB ArdiaJS` throughout. Each step passes when the app keeps working, the status
says what happened, and no tab or removed visit is lost or shows up twice.

1. **Connect.** Sync › connect with the Mac's phrase and its folder. Status reaches `updated`; the view lists
   the Mac, its profiles and its tabs.
2. **Runtime checks.** Every check prints PASS.
3. **Next profile.** Each tap moves `›` to the next profile, and `shown` follows it.
4. **Two runtimes under teardown and reload.** Tap Runtime checks, and while it runs tap Sync now; then reload
   the JavaScript (debug build: `r` in Metro; release: kill the app with `adb shell am kill` after leaving it).
   Repeat three times. Sync keeps cycling, the checks still pass, and nothing crashes (`adb logcat -b crash`).
5. **A slow or revoked folder.** Point sync at a folder on a provider that lags (a cloud drive's folder with
   the phone on a slow network): status shows `updating`, then `updated` or `stalled`, never a hang past a
   minute. Then revoke the grant (Settings › Apps › Ardia › clear the folder permission, or remove the folder in
   the provider): status turns `needsFolderAccess`, and Change folder recovers it.
6. **WorkManager with the app process dead.** Make a change on the Mac, leave the app, run
   `adb shell am kill com.ardia.browser.android.dev`, then
   `adb shell cmd jobscheduler run -f com.ardia.browser.android.dev <job id>` (ids from
   `adb shell dumpsys jobscheduler com.ardia.browser.android.dev`). Open the app: the change is there before the
   first foreground cycle, and the inbox holds any tabs the Mac sent.
7. **Stalled age.** Turn on airplane mode and wait three minutes: the status reads `Last synced N minutes ago`
   and N moves each minute.
- **Scanning the phrase.** The module's own `ScanView` (`scanner`, `@ardia/phone-native`) scans the Mac's QR code
  with the Compose app's CameraX and ZXing code and hands the text to `sync.connect`; expo-camera and its ML Kit are
  gone (00b9064e9). It asks for the camera again once a one-time grant has expired (d8460729e).

## System entry points on Android

The Expo app has the Compose app's entry points, beside the iPhone's:

| iPhone | Android |
| --- | --- |
| Default browser and http/https links | the browser role and `VIEW` intent filters for http, https and `ardia://` |
| Home Screen widgets (search, the Mac's tabs) | Glance widgets: Search, and Your Mac's Tabs where sync is offered |
| Lock Screen widgets | none |
| Control Center controls: Search, Voice Search, New Incognito Tab | Quick Settings tiles: Search, Voice Search, Incognito Tab, each opening what its launcher shortcut opens, after an unlock on a locked phone |
| Home Screen quick actions | app shortcuts: Search, Voice Search, New Incognito Tab, and Open Synced Tabs where sync is offered |
| Share extension | a share target (`ShareActivity`): Open in Ardia, Search in Ardia, and Send to Your Mac where sync is offered |
| Open in Ardia action | the same share target, and Search in Ardia in the text selection menu (`PROCESS_TEXT`) |
| App Intents and Siri phrases | `WEB_SEARCH` intents; no assistant phrases |
| Spotlight for open and archived tabs | none |
| Handoff of the current page | none: Android has no counterpart |

Where it can be shared, it is the app's own code:
- **Links.** `MainActivity` hands every intent to `PhoneSystemLinks` (`@ardia/phone-native`), which maps it to
  a `SystemLink` with the Compose app's `SystemLink` parser and queues it until the app listens
  (`system.initialLink()`, `system.addLinkListener`). http and https `VIEW` (default browser) is `open`, source
  `web`; `ardia://` from widgets and the tile is its kind, source `system`, and from launcher shortcuts, source
  `shortcut`; `WEB_SEARCH` and `PROCESS_TEXT` (Search in Ardia on selected text) search, or open a web
  address, source `intent`; `SEND` text opens its first link or searches the text, source `share`. A link is
  delivered once, not again on recreate or from Recents, and a new activity drops links an earlier one left
  untaken (50824c133). `system.setHidesFromRecents(hidden)` is the Compose
  app's Recents screenshot and `FLAG_SECURE` handling, for the screens to call while a private tab shows.
- **Default browser.** `defaultBrowser` uses the Compose app's `AndroidSystemActions` (`RoleManager.ROLE_BROWSER`).
- **Tiles, widgets and shortcuts.** The Quick Settings tiles (`ArdiaTiles.kt`: Search, Voice Search, Incognito Tab), the Compose app's Glance widgets (Search, Your Mac's Tabs)
  and `SystemSnapshots` compile in place in the Expo app, with its `res-system` resources and a small
  `ardia-design` library for `ProfileLook`, `Monogram` and `Colors`. `SystemExport` writes the widgets'
  snapshot from the wrapped sync controller, as the Compose app does; demo mode feeds no widgets.
- **Not ported.** Nothing: the share sheet (Open, Search, Send to Your Mac) and the widgets' Color tint are in.
- **Files.** A file request carries `offersPhoto`, `offersVideo` and `capturesDirectly` (the Compose app's
  `FileChooserPlan`); the answers `takePhoto` and `recordVideo` capture through the shared capture provider.
- **Open App Links In.** A global default (`pages.appLinksDefault`, `setAppLinksDefault`) with each site on,
  off or following it (`setOpensLinksInApps(host, null)`).

**What the Codex review of 15 November changed.**
- A share sent with Ardia cold waits for sync to load before it gives up. It is recorded before the wait, and a
  WorkManager job resumes it if the process dies. The sheet's ViewModel holds one key, so rotation never sends
  twice. Only sane extras are read (e8b5c7798).
- Native counts, such as the share sheet's tabs_sent, are kept only while usage sharing is on and within its
  consent generation. Turning sharing off clears them, and handing them to JS can lose a count but never double one
  (61df46a9a native; JS tells native the choice at start and on each change, 20e253b30).
- The tray's back callback is released with its module and rebound after activity recreation (8a9692af3). JS
  enables it only while nothing covers the tray (f7b1b8f87).
- The R8 name check finds Room's `WorkDatabase_Impl` constructor as one `<init>` method record with a `()V`
  descriptor (998f62979).

- **Sync is not offered in Android release builds** (the first Android release ships without it; lab builds keep
  it). One value, `SyncOffer.isOffered` in `packages/phone` (true in a lab build, false in a release build), decides
  every native entry point; JavaScript reads the same through `system.syncOffered()`. In a release build:
  - the share sheet offers Open in Ardia and Search in Ardia only, no Send to Your Mac and no hint to turn sync on;
  - the Your Mac's Tabs widget is not in the widget picker: its receiver is disabled by the build's
    `@bool/ardia_sync_offered`. A Your Mac's Tabs widget placed by a Compose tester build loses its provider, and
    the launcher shows that it can't be loaded until it is removed; no released build ever placed one;
  - the Your Mac's Tabs launcher shortcut is disabled the same way, and an `ardia://mac-tabs` link does nothing;
  - no sync controller is made, so nothing syncs, in front or in the background. Sync work a Compose tester left
    queued (`ardia-sync`, `ardia-sync-flush`) is cancelled at start, and a worker that runs anyway holds;
  - the sync code scanner reports the camera as unsupported and never opens it;
  - a Compose tester who had sync connected keeps the sync identity on disk untouched and unused; nothing is reset,
    so a later build that offers sync finds it as it was.
  `apps/phone/test/r8/check-names.py` lists the components the value switches and its value in the build.

#### Entry points tester script (lab build)

Before any run, prove the phone has the build you were sent:
- Clear old Ardia APKs from the phone's Downloads first, so an on-phone installer cannot pick an old one
  (sync13 on the M3 once installed sync12 that way): `adb shell ls /sdcard/Download | grep -i ardia`, then
  `adb shell rm /sdcard/Download/<each old ardia apk>`.
- After installing, hash what is installed and compare it with the `sha256:` line of the build's `.txt`:
  `adb shell sha256sum $(adb shell pm path com.ardia.browser.android.dev | sed -n 's/^package://p' | grep base.apk)`.
  An `adb install` of a single APK keeps it byte for byte as `base.apk`.
- On the first launch logcat has `PAGELAB build <commit> dirty: no …`, and the commit must be the one sent
  with the APK. If the hash or the commit differs, stop and reinstall: nothing measured on the wrong build
  counts.

`P=com.ardia.browser.android.dev/com.ardia.browser.android.MainActivity`. Open the lab
(`adb shell am start -n $P --ez com.ardia.phone.PAGE_LAB true`), tap System, and watch
`adb logcat -s PAGELAB | grep "PAGELAB system"`. Each command should print one `PAGELAB system link`
line with the kind and source shown. The lab also prints `PAGELAB system default browser` once when it opens
and again only when that status changes.

1. **Web link:** `adb shell am start -a android.intent.action.VIEW -d https://example.com/a -n $P`: open, web.
2. **Ardia links:** the same with `-d ardia://search?q=otters` (search, query otters), `ardia://voice`
   (voiceSearch), `ardia://incognito`, `ardia://mac-tabs` (macTabs), `ardia://tab/t1` (tab, id t1),
   `ardia://open?url=https%3A%2F%2Fexample.com%2F` (open), `ardia://inbox`: each with source system.
3. **Shortcuts:** long-press the app icon: Search, Voice Search, Incognito Tab, Synced Tabs each give their kind
   with source shortcut.
4. **Web search:** `adb shell am start -a android.intent.action.WEB_SEARCH --es query "red pandas" -n $P`:
   search, intent. With `--es query https://example.com/`: open.
5. **Selected text:** select words in any app, choose Search in Ardia: search with the words, intent. Or
   `adb shell am start -a android.intent.action.PROCESS_TEXT -t text/plain --es android.intent.extra.PROCESS_TEXT "two words" -n $P`.
6. **Share:** share a page from another app and pick Ardia: open, share. Or
   `adb shell am start -a android.intent.action.SEND -t text/plain --es android.intent.extra.TEXT "Look https://example.com/b." -n $P`
   (open https://example.com/b) and with `"just words"` (search).
7. **Once only:** after a link, go to Recents and back to Ardia, and rotate if the screen allows: no new line.
8. **Cold start:** force-stop the app, then run step 1 with `--ez com.ardia.phone.PAGE_LAB true` added: open
   System; the initial link line shows the link.
   Expected on every cold start, as in both native apps, and not a failure: with Auto-Open Keyboard on the app
   opens on the start page with the tray and keyboard up over the start page's backdrop (its logo and bar faded out,
   so nothing else shows behind the tray), never over the last page or the deck. Back closes the tray onto the
   selected tab. Report only a white or empty frame behind the tray, which e10082e90 removed.
9. **Default browser:** the status line shows isDefault and canAsk; Request role shows the system dialog and
   the line follows the answer; Default apps settings opens the settings page.
   `adb shell cmd role get-role-holders android.app.role.BROWSER` agrees. With Ardia as the default, step 1
   without `-n` opens Ardia directly.
10. **Recents:** Hide from Recents, then open Recents: Ardia's card is blank. Show in Recents restores it.
11. **Quick Settings tile:** add Ardia's Search tile; tapping it opens Ardia with a search link (system). With
    the phone locked it asks to unlock first.
12. **Widgets:** add Search and Your Mac's Tabs from the launcher's widget picker. Search: the field gives
    search, the mic gives voiceSearch. Your Mac's Tabs with sync off: "Sync With Your Mac"; with real sync
    connected, the Mac's tabs within a cycle, and a row opens its page (open, system). Dark mode switches the
    Search widget's backdrop.
13. **Take Photo and Record Video:** load
    `data:text/html,<input type=file accept=image/*><input type=file accept=video/* capture>` in the lab and
    tap each input: the request line shows photo/video/direct; Take photo asks for the camera once, opens the
    camera, and the page gets the picture; the second input (capture) records video.
14. **Desktop Site on the POCO F4** (it failed there on `sync3`): Desktop on for google.com, github.com,
    wikipedia.org and bbc.com. The `PAGELAB desktop` lines should show `switched on`, then `pageFinished` at
    the tag's scale (visualViewport.scale about 0.38, not 1.0000) with no visible jump, and each page fitting
    the width. GitHub at 980 px shows its narrow layout, as Chrome's desktop mode does on phones.
15. **Sync, demo mode:** Before the demo launch, note the deck's real tabs. The demo shows its own eight tabs (Sintra
    selected), four archived and its own history; open, close, archive and move tabs freely, then relaunch without the
    demo: the real tabs, their pictures and scroll positions are exactly as before, and tabs a Mac sent during the demo
    arrive then. Stop Syncing turns the demo off (the card and the deck show the disconnected state);
    the next demo launch is on again. A rename shows in the devices list; Pin to Mac fills the star. Damage inbox
    in the Sync section sets the status's `inboxProblem` (the Sync section's status lines show it) and the app
    shows its notice; after a force-stop and relaunch the notice is still there, until sync next writes the
    inbox.
16. **Shortcuts with the app in the background:** open the System section, press Home (don't swipe the app
    away), and use each launcher shortcut. Ardia comes back without restarting (the lab is still open, no
    splash) and prints one link line with source shortcut. `adb logcat -b main | grep -c "Unable to find viewState"`
    stays 0.
17. **Not yet covered:** the tile with the phone locked behind a PIN (it asks to unlock, then opens the
    search); the Search widget's mic (at its medium size, 4×2: the Compose widget shows the mic only from 250 dp
    wide); Search in Ardia on text selected in a real app; a share from a real app (Chrome's Share › Ardia).
18. **Widgets and dark mode:** with the app in the background, switch the phone between light and dark: both
    widgets' backdrops follow within a second.
19. **Scanner:** Scanner section › Ask for camera, then point at the Mac's sync code: one
    `PAGELAB scan code: N characters, 24 words, valid true` line and nothing with the words; another QR code
    gives `rejected`. Pause stops the camera (its light goes off). The phrase never appears in logcat.
20. **Voice:** Voice section › Ask for mic, Start, speak: `PAGELAB voice partial "…"` lines and one `final`
    line; Stop ends it; a silent start ends with `failure nothing heard`. In airplane mode, note whether words
    still arrive (they do when the phone has an on-device recognizer).
21. **Swipe and pull:** on the lab's page after two navigations, with Swipe anywhere: a drag right from mid-page
    goes back, left goes forward, short drags spring back; a horizontally scrolling area (a carousel) scrolls
    instead. Swipe edges: only drags from within a finger's width of the edge navigate. Pull on: at the top, a
    pull past the arrow's full turn taps a haptic and reloads with the spinner; scrolled down, a downward drag
    scrolls.
    Past the history (in the app, not the lab): on a tab with no back history, a back swipe closes the tab and
    lands on the tab used before it (the start screen when none is left); right after, a forward swipe on that
    page reopens the closed tab when the page has no forward history (with forward history it goes forward).
    With Swipe off neither runs, and with Swipe edges only from the edge.
22. **Online again and favicons:** System › Favicon looks prints three lines with tones and backings; turn
    airplane mode on and off: `network lost`, then `online again` once.
23. **Accessibility dump:** in the app (not the lab), open the tray, the page menu, a long-press menu, Spaces
    and the Archive sheet in turn, and with each open run
    `adb shell am broadcast -a com.ardia.phone.A11Y_DUMP -p com.ardia.browser.android.dev` and
    `adb logcat -d -s PAGELAB | grep "PAGELAB a11y"`. The lines between `begin` and `end` are what TalkBack can
    reach; the surface behind a cover should not be among them.
Look checks (24, 25, 32, 33, 38) start from the look on. The lab's Look on/Look off switch lasts across launches
and app updates, so before the first of them open the lab's Look, set Look on (logcat `PAGELAB look views on`),
force-stop and reopen the app. The deck's `PAGELAB look deck draws …` line then ends in `look on`, not `look switched
off in the lab`.

24. **Look:** the lab's Look section. Look plum/green/orange/incognito: the deck backdrop's blobs move (still
    with Reduce motion), incognito draws dark even in Light; the middle tile with Fades out goes from the backdrop
    at the top to the plain system background by 80% of its height; each Frost variant shows the blobs blurred
    behind it.
25. **Frost over a page:** in the Look section, scroll the Wikipedia page under "Sheet frost over the page" and
    watch `adb logcat -s PAGELAB | grep "look frost"`. The line `path=live (page under the frost, redrawn every
    frame)` means the blur is drawn from the page: the frost should show the page blurred and follow the scroll.
    If it is black, grey or frozen, tap Probe frost (one line with the frost's mean brightness and near-black
    share), then Page frost solid: the line says `path=solid` and the frost turns the sheet's plain colour. Report
    which one the phone needed.
    From sync12 a frost over a page is solid by default (`path=solid (page under the frost, solid page mode)`):
    blurring a page records its WebView into an offscreen layer, which blanked the page for 3 to 4 frames on the
    M3, and the Compose app never blurs a page. The lab's Page frost live is there for comparison only.
26. **Telemetry, nothing while off:** watch `adb logcat -s PAGELAB | grep telemetry`. With sharing off (a fresh
    install starts off), use the app for a minute, background it and come back: no `PAGELAB telemetry posted`
    line. Turn on "Share anonymous usage stats" in Settings, background the app: lines appear
    (`POST ardia.dev/otel/v1/logs -> 200`). Turn it off: no more lines. The same switch is on onboarding's last
    steps (Settings › Show Onboarding). Settings › What’s Sent lists what is counted. A lab release build sends to
    ardia.dev with environment test.
27. **Memory after tabs close** (the lab broadcasts here and below, MEMORY, FRAMES, TRIM and DECK_PARTS, are
    answered while Ardia is in front. From sync20d its receiver also stays registered in the background, but
    Android 14 and later, and MIUI's freezer, hold a broadcast to a cached app until it is back on screen. For the
    background itself use `adb shell dumpsys gfxinfo $P` and `dumpsys meminfo $P`.)
    `adb shell am broadcast -a com.ardia.phone.MEMORY -p com.ardia.browser.android.dev`
    and `adb logcat -d -s PAGELAB | grep "PAGELAB memory"` (or System › Memory) at four points, after a
    force-stop and cold start each time you start over: with one tab; after opening nine tabs and visiting each;
    after closing eight of them; and after `adb shell am broadcast -a com.ardia.phone.TRIM -p
    com.ardia.browser.android.dev` (System › Trim, the same clear Android's low-memory signal does). Report the four
    lines; the image cache's MB should fall when tabs close.
28. **Scanner without a camera:** Scanner section with the camera allowed: Feed a phrase code gives
    `code: … 24 words, valid true`, Feed another code gives `rejected`; no recovery phrase in
    `adb logcat -d | grep -i -E "abandon|zoo|^[a-z]+( [a-z]+){23}$"` or anywhere else. After an "Only this time"
    camera grant expires, Ask for camera shows Android's prompt again, not Allow Camera Access.
29. **Swipe over a carousel:** as in step 21 with Swipe anywhere, a sideways drag that starts on a carousel that can
    scroll that way scrolls it (logcat: `PAGELAB swipe left to the page`), and only a drag the carousel cannot
    take navigates.
30. **No replayed link:** open the Voice Search shortcut, leave the app in the background, then
    `adb shell am start -W -a android.intent.action.VIEW -d https://example.com/ --activity-clear-task -n $P`: the
    app opens example.com, not the voice screen.
31. **Widgets in both modes, quickly:** with both widgets on the home screen, switch dark, light and dark again
    within 20 s: each switch updates the whole widget (panel, pill, text, icons) together within a few seconds,
    and the Search pill shows its icon and label in both modes.
    Since the widgets carry both modes' colours (Android 12 and later), also add each widget once in light mode
    and once in dark mode, then switch modes with the app closed (`adb shell am force-stop $P` first): every
    widget follows within a few seconds whichever mode it was added in, its panel keeps a gradient, and the
    pill, icons, label and text all change together. Watch `adb logcat -s ArdiaWidget`: each update logs
    `widget search|macTabs update on API N: the launcher picks day or night …; the app sees day|night`. A switch
    with the app closed needs no update line at all. If a widget doesn't follow, report whether any line
    appeared and what it said.
    With TalkBack on, each widget reads its name from the moment it is placed, before its first update: "Ardia
    Search" and "Ardia, Your Mac’s Tabs", never "Ardianull".
    MIUI's launcher reads its own frame around a widget as "Ardianull"; the Compose app's widgets read the same on
    the same launcher (F4, sync12), so it is the launcher's and is not checked further.
32. **Deck backdrop:** in the app's deck, three slow blobs in lighter shades of the profile colour drift over the base
    (two screenshots 10 s apart differ). In the lab, Look: the stage above the frosted bar shows the mesh and blobs
    in every look, its caption sits at the bottom of the stage, and the frosted bar's label is centred. Tap Probe
    frost: `PAGELAB look deck probe:` gives each deck's size (never `0x0`), frames and fps (about the panel's rate
    while moving, 0 more frames while still), and three `probe pixel` lines. The centre pixel is close to the
    `mesh centre` colour, and the blob 1 pixel is lighter than it in light mode. `PAGELAB look deck size` and
    `first frame` lines appear once per deck. A look view that cannot draw shows a flat colour and logs
    `PAGELAB look <View> could not draw …` once instead of crashing; report any such line.
33. **Frost:** open the tray over the deck in dark mode. Behind the suggestion rows, the deck bar's three buttons
    show only as soft smudges, never as sharp icons. In the lab's Look, the frosted bar over the stage is the
    stage's colours blurred in every look (green: blurred green and blue, not flat lavender), and over incognito
    its label is white. The sheet frost over the page follows the page as it scrolls. Probe frost logs
    `path live` for both lab frosts, never `inside its own source`, each with its frost and source sizes.
    Every frost logs `PAGELAB look frost <name or source/variant #n> WxH path=… (reason)` whenever its path
    changes, so a button without glass shows why. Over a still page the tray's frost redraws a few times a
    second, and every frame only while the page scrolls; measure with the look on and off as in step 38.
34. **Voice screen in light mode:** the backdrop is the dark profile backdrop, with the white "Listening…", X and
    stop button readable on it, the same as in dark mode.
35. **Swipe over a carousel, both ways:** with Swipe anywhere, on a page with back history and a sideways
    carousel (a news site's story strip), scroll the carousel partway, then drag it right and left. Both drags
    scroll the carousel and neither navigates. Each drag logs `PAGELAB swipe decide …`, with the page's own
    scroll, history, the scroller report (`LR`, `-R`, `L-` or `not reported`) and the choice. A right drag on the
    carousel then logs `swipe left to the page … the scroller under the finger can scroll back` or
    `the page asked to keep it N ms after touch down`. A right drag on plain text, away from any carousel, still
    goes back (`swipe back claimed …`).
36. **Offline page:** load a page, turn on airplane mode, then open a new page and reload the first. Each tab keeps
    its last real title, or shows the address's host when it never loaded: on the deck, in the Archive, in the page
    menu and in History, never "Web page not available". The deck card keeps the page's last good snapshot (or
    the placeholder), never the WebView's white error page. Also open three heavy pages one after another (Wikipedia, github.com, bbc.com/news): each
    draws within a few seconds. If one stays pink or white, report the `PAGELAB page view …` lines from opening it
    (`shows its WebView at WxH`, `taken from another view`, `lost its WebView`, size changes). In dark mode the bottom bar stays dark over the
    offline view. Turn airplane mode off and tap Try Again: the real title, colours and a new snapshot come back.
37. **Memory after closing tabs:** as in step 27 (one tab, nine tabs, close eight), tap Memory after each stage. The
    image cache line now reads `X MB in N images (shown A MB in a, kept B MB in b)`. Each close logs
    `PAGELAB memory page closed: …` and `PAGELAB memory page snapshots deleted: F file(s), dropped D decoded, …`.
    The close and the delete run at once on different threads, so whichever runs first drops the decoded images:
    when the delete wins, the close says `no snapshot files left (…)` and the delete line carries the drops. For
    a tab that had a card, one of the two lines drops 1 or more; report any close of a carded tab where both say
    0. The image cache after closing eight is no larger than with nine open. Then run
    `adb shell am send-trim-memory com.ardia.browser.android.dev RUNNING_CRITICAL` (Android's own signal, which
    also trims the system's GPU caches; the lab's Trim only clears the image cache) and tap Memory again. Report
    all the lines, graphics included.
    - Each Memory line now ends with `look on|off: N of M frost(s) blurring, about X MB of blur layers (largest …),
      D of E deck backdrop(s) shown`, and a trim logs `PAGELAB memory trim level L: image cache cleared; look
      trimmed: …`. Do the one-tab and nine-tab stages twice, look on and look off (step 38's switch, force-stop
      between), so the look's share of graphics shows.
    - Android only releases GPU caches, the WebViews' tiles included, at "UI hidden" or deeper, not at
      `RUNNING_CRITICAL` with the app in front. So also press Home, run
      `adb shell am send-trim-memory com.ardia.browser.android.dev UI_HIDDEN`, come back and tap Memory.
38. **Frames with and without the look:** measure twice, look on and look off, doing the same thing each time.
    - In the lab's Look, set the toggle (Look on or Look off; it logs `PAGELAB look views off|on` and lasts across
      launches), then `adb shell am force-stop $P` and open the app normally.
    - `adb shell dumpsys gfxinfo $P reset`, then for 30 s: open the deck, scroll it, open and close the tray over
      it, open a tab and go back. Then `adb shell dumpsys gfxinfo $P | grep -E "Janky|percentile"`.
    - With the look off, the deck and backdrops are flat colours and the frosts solid. Report both sets of lines,
      then switch the look back on.
    - Then twice more with the look on and the lab's Blobs button at `Blobs 30 fps` and `Blobs 20 fps` (it logs
      `PAGELAB look blobs at N fps` and lasts across launches; set it back to `Blobs every frame` afterwards).
      The Compose app draws its blobs every frame and blurs each bar frost every frame too, so "every frame" is
      parity; the capped runs tell whether a cap is worth its look. Also, from the look-on run, the idle deck:
      `adb shell dumpsys gfxinfo $P reset`, leave the deck untouched for 10 s, then the same grep.
    - From sync16 the backdrop draws its mesh and blobs into a small image (an eighth each way, 135 x 300 on a
      1080 x 2400 phone) and scales it up, with the grain a static layer over it. The deck's draw line ends
      `backdrop drawn as a small image scaled up (scene 135x300)`. While it holds still under a scroll the GPU
      replays one opaque scaled bitmap and the grain texture, not the gradients. The lab's `Backdrop:` button
      cycles `small image` (the default), `small, no grain` (the grain's share), `full size` (sync15's drawing,
      as Compose draws it) and `flat colour` (a flat fill repainted at the blobs' pace, so the cards and the bar
      above are recomposited exactly as often while the backdrop itself costs nothing). Force-stop after each
      switch. On both phones, with the look on and paced, on the idle deck, once per mode:
      `adb shell dumpsys gfxinfo $P reset`, 10 s untouched, then
      `adb shell dumpsys gfxinfo $P | grep -E "Total frames|Janky|50th|90th|gpu|Slow issue"`. The target on the F4
      is a 50th percentile under 8.3 ms with `small image`. Then, per mode, the deck scroll (`sched-scroll.txt`, or
      the Deck speed script's step 2) with the full look forced, against look off: sync15's M3 scrolled at 77 to
      81% janky with the full look against 29 to 47% off, with nothing of the look redrawing, so the held
      backdrop's replay was the cost; `small image` should bring it near look off. `flat colour` against `small image` gives the
      backdrop's own cost, and `flat colour` alone what recompositing the rest costs. If `flat colour` is itself
      near 8 ms, report it: the cards then need to be held on layers while the deck rests. Also run the FRAMES
      broadcast on the idle deck in each mode: the look views should be `DeckBackdropView` at the paced rate and
      each bar `FrostView` far less often, since a tinted frost redraws only when its colour changes.
    - When the Compose app is installed (before an upgrade run), do the look-on run on its deck too, the same
      30 s, and the idle 10 s, and take a light-mode deck screenshot in the same profile colour: both apps' blobs
      come from the same `ProfileLook.deckBlobs` and `DeckBackdropStyle` numbers (light blobs at 0.86 to 0.9
      lightness, 0.85 opacity), so the two screenshots should match.
    - From sync12 the blobs are paced by default: the deck redraws each time the fastest blob has moved 1% of its
      radius (about 25 fps on a 1080x2400 deck), and the frosts re-blur only then, each at a quarter to an eighth
      of its size. The Blobs button cycles `Blobs paced`, `Blobs every frame` (Compose's rate), `Blobs 30 fps`,
      `Blobs 20 fps`. Measure look off, paced, and every frame; the budget is paced within 2 ms of look off at the
      median.
    - From sync14 the deck bar's frosts, which sit over nothing but the backdrop, are fills tinted from the
      backdrop's colours under them, with no blur layer: the bar's colour follows the blobs, but the blobs are
      not seen through it. Logcat has, at each deck build and for each frost, `PAGELAB look frost … path=… (why);
      source deck: …`, which says what the frost found in its source. For the bar it should read `path=tinted
      … source deck: only the deck backdrop shows: N view(s) under it hidden by it, M over it that draw
      nothing`. When it reads anything else, report the line: it names the view that kept the blur (sync14's
      bar stayed `path=live` because an empty view sat beside the backdrop, which sync15 ignores). The Memory
      line says
      `… holding a blur layer (3 tinted from the backdrop)` and the DECK source no longer recording. The lab's
      `Bar frosts: tinted fill` / `Bar frosts: blur` button brings back the old blur to compare (it lasts across
      launches; set it back to tinted afterwards). On the M3, the idle deck with the look on, paced, once each
      way: `adb shell dumpsys gfxinfo $P reset`, 10 s untouched, then
      `adb shell dumpsys gfxinfo $P | grep -E "Total frames|Janky|50th|90th|Slow issue"`. Report both, and a
      deck screenshot each way in the same profile colour.
39. **Keyboard target:** right after a fresh launch (`adb shell am force-stop $P` first), open the tray. Logcat has
    `PAGELAB keyboard will change 0.0 -> N dp in M ms` as the keyboard starts to rise, then
    `PAGELAB keyboard did change to N dp` with the same N, and the tray rises with the keyboard on that first open
    too. Close the tray, switch to a keyboard of another height (emoji panel or a different keyboard app), and
    open it again: the will-change line already has the new height.
40. **Connect in two steps**: pick the sync folder (Choose Folder… under step 2; its name then shows there), then enter a
    phrase with one wrong word: connecting starts by itself and fails with the phrase's message, and the folder's
    name stays. Fix the word: it connects again by itself, no folder picker opens, and sync connects. Then Stop Syncing, pick a folder and leave without connecting; pick another folder and connect with
    it. `adb shell dumpsys activity uri-permissions | grep -i ardia` (or the Files app's access list) shows only the
    connected folder's grant, not the one left unused.
41. **Launch arguments** (lab build): run the capture commands from "Launch arguments on Android" against the Expo
    app, for example
    `adb shell am start -S -n $P/com.ardia.browser.android.MainActivity --ez ArdiaDemo true --es BrowseQuery otters`,
    `… --ez ArdiaDemo true --ez BrowseDeck true`, `… --ez ArdiaDemo true --es ArdiaOpenSheet settings` and
    `… --ez ArdiaOnboarding true`. Each does what it does in the Compose app, and with `ArdiaDemo` the sync view
    shows the demo Macs, not the real ones. Lab builds log `PAGELAB launch arguments {…}` once per launch
    with what the app was given. A store build ignores every one of them.
42. **Inline completion** (the tray on Android, and the lab's Completion panel). Do it first in the app's real tray
    (open it from the deck or a page), then in the lab:
    - In the tray, type `goo`: `gle.com` shows highlighted after the caret. Press Enter (the keyboard's Go): the tab
      opens google.com. Open the tray again, type `goo`, press Backspace once: only `gle.com` goes, `goo` stays,
      and typing `g` brings the highlight back.
    - Type `goo`: `gle.com` appears after the caret, highlighted, and the caret stays after `goo`.
    - Type `g`: the highlight shrinks to `le.com` with no flicker. Type `x`: the highlight goes and `googx` stays.
    - Backspace with a highlight showing removes only the highlight, then typing brings offers back.
    - Tap inside the text or select a word: the highlighted part becomes ordinary text.
    - Go submits the whole `google.com` (`PAGELAB completion submit "google.com" via keyboard action 2`, in the
      tray as in the lab). Leaving the field drops the highlight. A hardware Enter logs `via enter key`; if the
      keyboard also turns it into its Go action, the second one logs `submit ignored … the same press already
      submitted` and only one tab opens.
    - With a Chinese or Japanese keyboard, no highlight shows while composing.
    - Speed: tap Focus, `adb shell dumpsys gfxinfo $P reset`, then
      `adb shell input text googleandsomemoretextthatgoesonandonforsixtyfivecharactersintotal12` (65 keys) and
      `adb shell dumpsys gfxinfo $P | grep -E "Janky|50th|90th"`. The 50th percentile stays at or under the earlier
      runs' 13 ms on the same phone; report the three lines.
    - The same speed run in the real tray: open the tray with an empty field, then the same reset, `input text` and
      `gfxinfo` lines. The suggestions under the field update as you type, so report these three lines apart from
      the lab's.
43. **Deck with TalkBack**: with TalkBack on and eight tabs open, put
    the focus on a card and use TalkBack's scroll actions (the actions menu, or a two-finger swipe). The deck moves one
    card each way, as Compose's page left and right do, and at either end the action that can't move is not offered.
44. **Onboarding survives a recreated activity**: turn on
    Developer options › Don't keep activities, start onboarding on a fresh install, go to its third step, press
    Home, then come back from Recents. Onboarding reopens on the third step, not the first. Turn the option off
    afterwards.
45. **TalkBack behind Spaces, the Archive and Settings**: with TalkBack on, open the deck, then Spaces. Swipe
    right through every element to the end, then left back to the start: TalkBack reads only the sheet, never the
    deck's three buttons (Spaces, New Tab, the menu) or a card. Run the dump from step 23 with the sheet open: no
    deck button between `begin` and `end`. Close it, then do the same with the Archive and with Settings. Then close
    the sheet: the deck's buttons are read again. Report any sheet where a deck element is read, with its dump.
46. **Closing tabs from the deck** (sync10 crashed here): with nine tabs open, close ten tabs one at a time by
    flicking a card up or sideways, opening new tabs to keep a few, then ten more with the card's long-press menu
    (Close Tab). Each close flies the card off the top while the deck closes the gap; nothing freezes and `adb logcat -b crash`
    stays empty. Then close the last tab both ways: the app goes to the start screen. Report any crash with its
    `logcat -b crash` lines.
47. **The tray's blank frame** (the frame where the tray showed nothing over a page): with the look on, on a page
    (Wikipedia), open and close the tray ten times while recording the screen (`adb shell screenrecord
    /sdcard/tray.mp4`, stop with Ctrl-C after 30 s). Then the same with the look off (step 38's switch, force-stop
    between). For each run report whether any frame shows the tray blank (no frost, no rows) and the
    `PAGELAB look frost surfaces/sheet #N …` lines (the tray's frost) with their `path=` and reason. If it only happens with the look on,
    the frost is the cause; if both, it is not the look.
48. **The blank tab** (sync9's BBC tab): open bbc.com/news, wikipedia.org and github.com in three tabs, go to the
    deck and back into each twice. If a tab shows blank, pink or white, note which and report every
    `PAGELAB page view …` line from that moment (`shows its WebView at WxH`, `taken from another view`,
    `lost its WebView`, `size A -> B`) with a screenshot, and the same lines from a tab that drew.
49. **TalkBack for real.** A test tool that uses UiAutomation (uiautomator, agentos) keeps other accessibility
    services from running while it is attached, so touch exploration stays off. So:
    - Set the scene first, with the tool: open the deck with eight tabs, then Spaces.
    - Stop the tool, so nothing holds UiAutomation (`adb shell ps -A | grep -i -E "uiautomator|agentos"` should
      list nothing; stop its server or `adb shell am force-stop` its package).
    - Turn TalkBack on from adb:
      `adb shell settings put secure enabled_accessibility_services com.google.android.marvin.talkback/com.google.android.marvin.talkback.TalkBackService`
      then `adb shell settings put secure accessibility_enabled 1`. MIUI may ship TalkBack as
      `com.google.android.marvin.talkback` or not at all; `adb shell pm list packages | grep -i talkback` says.
      In TalkBack's settings (Advanced › Developer settings) turn on Display speech output, so what it says
      shows on screen and `adb shell screencap` can capture it.
    - Move with TalkBack's keyboard shortcuts, which need no touch: next item
      `adb shell input keycombination KEYCODE_ALT_LEFT KEYCODE_DPAD_RIGHT`, previous item the same with
      `KEYCODE_DPAD_LEFT`, activate `adb shell input keycombination KEYCODE_ALT_LEFT KEYCODE_ENTER` (Android 13
      and later have `input keycombination`). After each move take `adb shell screencap -p /sdcard/tb-N.png`.
      Step through the whole sheet and past its end: report every item read, and whether any is a deck button
      (Spaces, New Tab, the menu) or a card.
    - Turn TalkBack off (`adb shell settings put secure enabled_accessibility_services ""`), reattach the tool,
      open the Archive, and repeat; then Settings; then no sheet, where the deck's buttons are read. If MIUI
      ignores the key combinations, say so: then only a hand on the phone can do this pass.
50. **Step 38 and the memory steps in their sync11 form**: run step 38 with every bullet (look off, look on with
    blobs every frame, at 30 fps and at 20 fps, the idle deck, and the Compose baseline if Compose is installed),
    then step 37 with the look on and off, the frost megabytes from each Memory line, and the Home plus
    `UI_HIDDEN` trim.
51. **The look's budget** (first switched on in sync13). Watch `adb logcat -s PAGELAB | grep "look budget"`.
    - Start clean: fresh install, or the lab's Look › Budget: reset (then force-stop). Look on, blobs paced.
    - Open the deck and leave it untouched for 4 s: after its first second the deck samples 2 s and logcat has
      `PAGELAB look budget over|within|inconclusive: verdict …, next build full|degraded, last N frames, median
      X ms against Y ms, Z% missed`. Touching the deck in those 3 s drops the sample (no line): leave it alone.
    - Close the deck (go to a page), open it again, leave it 4 s: a second line. One deck open gives at most one
      sample, so a third line needs a third open.
    - What the lab shows: Look › "Look budget: …" with the same verdict, the look the next build will get, the
      last sample's frames, median against deadline and share missed, and "lab forces …" when forced.
    - The look never changes in front of you: when the second `over` arrives the deck you are looking at keeps
      its blobs and frosts. Only after closing and opening the deck again (or force-stop and reopen) does it
      stand still with plain fills, and then the Memory line reads 0 recording, 0 holding a layer, 0 animating.
      Report if anything changed while the deck stayed open.
    - From sync16 the verdict is the look's duty cycle, not each frame against the display's deadline. The line
      reads `… last N frames, median X ms, busy B% of the time (limit 33%), one frame every P ms over 2.0 s,
      keeps up; against the display's deadline D ms (display H Hz), M% missed (not judged)`. A sample is over
      when the backdrop's frames add up to more than a third of the window, or when its median frame is longer
      than the pace it is drawn at (the phone cannot keep up).
    - Expected in sync16, with the backdrop drawn as a small image: the F4 is `within`. sync15 measured 28.9 ms
      frames, busy 56%, and it passes once a frame costs under about 16 ms. The M3 is the open question (sync14
      drew 48 to 69 ms frames). If it measures `over` twice it degrades, which is the rule working. Report
      both phones' lines, with the busy share and the median, and the lab's text.
    - The lab's controls: Budget: force degraded (from the next build the look is still and solid), Budget: force
      full, Budget: measured (back to what was measured), Budget: reset (forget everything and measure again on
      the next deck open). Check each takes effect only after the deck is rebuilt.
    - System settings win: with Remove animations on (Settings › Accessibility), the deck stands still whatever
      the budget says, and no sample is taken (nothing moves to measure).
52. **An idle app draws nothing** (sync11's look-off deck drew 1825 frames in 30 s with nothing changing). With the
    deck open and untouched, run `adb shell am broadcast -a com.ardia.phone.FRAMES -p com.ardia.browser.android.dev
    --ei seconds 5` and keep hands off for 5 s. Logcat (`-s PAGELAB`) has `PAGELAB idle frames: N frame(s) drawn in
    5.0 s, … draw pass(es), … layout pass(es), … with no view redrawn; look views redrawn: <view> xN, …; redrawn:
    <view> xN, … and K more`. The look views (backdrops, frosts, frost sources) are listed first and in full,
    then up to 16 of the deepest other views that were redrawn, and how often. Do it with the look off (expected: 0 frames, nothing redrawn), with the
    look on (expected: the deck backdrop at its paced rate, about 25 a second, and nothing else), and on a page
    left still. Report every line; any view other than the deck backdrop, or any layout passes, is the leak to
    chase.
53. **The look lets go when the app is hidden.** Look on, nine tabs, tap Memory (step 37) and note the look part
    (`… frost(s) holding a blur layer, about X MB …`). Press Home, then
    `adb shell am send-trim-memory com.ardia.browser.android.dev HIDDEN` (this Android's name for UI_HIDDEN). Logcat
    has `PAGELAB memory trim received: level 20 (UI_HIDDEN); …; look released for the hidden app: N frost
    layer(s) …`; every trim the app receives now logs one such line, whatever its level, so a missing line means
    the app never got it. Come back and tap Memory: graphics should be near the look-off figure until the deck is
    shown again. Report the graphics figure after Home with the look on and off.
54. **Graphics memory after closing tabs (settled in sync14).** With the look off, graphics stays at about 88 to
    90 MB after closing eight of nine tabs, against 45 to 56 MB with the look on. sync14's F4 showed what it is:
    GPU memory 105 MB, of which about 100 MB purgeable. It is the renderer's own cache of textures it no longer
    needs, which Android takes back on its own: at UI_HIDDEN (Home), under memory pressure, or when the app
    goes to the background. No public API asks the renderer to trim while the app is in front, and sync14's
    one redraw after closes did not shrink it, so that redraw is gone from sync15. Nothing to run. Report it
    only if graphics after Home stays above about 30 MB, or `dumpsys gfxinfo $P` shows a large GPU total that
    is not purgeable.
55. **Deck scroll, look on against look off** (from sync14). Run the Deck speed script's step 2 (`## Deck speed`)
    four times on each phone, two with the look off and two with it on (paced, budget forced full on a phone
    that degraded). Force-stop between look switches. In each look-on run also:
    - start `adb shell am broadcast -a com.ardia.phone.FRAMES -p $P --ei seconds 5` just before the first swipe.
      During the scroll, `redrawn:` should list the cards and not `DeckBackdropView`, or only once or twice
      when the scroll starts and stops: the backdrop holds still while anything else draws;
    - from the `PAGELAB perf deck scroll` lines, check the look field reads `look drew backdrop 0, recorded 0,
      blurred 0, retinted 0` (sync13's older field read `1 3 1`);
    - the `look drew …` counts are what the look did during the window (its running totals at the end less those at
      the start). What each interaction should show, from sync20:
      - a deck scroll and a card open: all 0;
      - a deck open: `backdrop 1, recorded 0` (the backdrop's first frame on the new deck, with the look on or off),
        and 0 blurred and retinted beyond the bar's first fill;
      - a tray open over the deck with the look on: `blurred` about one per frame of the rise (sync17b: 27 to 30)
        and `recorded` a few (the tray's sheet frost blurs what's under it as it rises, which is the look working);
        with the look off, all 0.
      Anything beyond that is a bug: report the line with the step and the time;
      the `at end recording … holding … animating …` part after them is only its state when the window closed, so
      a short swipe in a 1.2 s window can show `animating 1` there without being a cost;
    - report, per run, the janky share, the 50th, 90th and 99th percentiles, and the slow issue-draw commands.
      Look on should now be within a point or two of look off. If it is not, the FRAMES line names what is still
      being redrawn.

56. **Site permissions ask Android first** (from sync18). On a fresh install, with no camera, microphone or location
    permission granted:
    - Open webcamtests.com and start the test. Android's own camera dialog comes first; the site's Allow dialog
      appears only after Android grants. Allow it: the camera picture shows.
    - Open a map and tap its "my location" button. Android's location dialog first; approximate location is
      enough for the site's dialog to follow.
    - Clear Ardia's permissions (Settings › Apps), open the camera test again and refuse in Android's dialog: no site
      dialog follows, and logcat has `PAGELAB page request camera refused by Android: the site's request ends
      without a dialog`.
    - A permission Android already holds goes straight to the site's dialog with no Android dialog.
57. **Pull to refresh** (from sync18). Pull a page down past the trigger and let go: the spinner is the Ardia blue
    (#6395FC, #4A77D4 in dark), the pull holds at 56 dp while the page reloads and springs back with a slight
    overshoot when it is done. A short pull that doesn't reach the trigger springs back the same way. On a page with
    no background colour of its own, swipe back from the edge: what shows behind is the profile's surface colour,
    not plain white or black.
58. **The widgets take the Color setting** (from sync19b). With the Search and Your Mac's Tabs widgets on the home
    screen, set Settings › Color to green: both widgets turn green within a few seconds; set it back to the
    profile's colour: they follow. Force-stop Ardia and switch the phone between light and dark: they keep the
    chosen colour.
59. **The pager rounds pages to the display's corner** (from sync18). On Android 12 or later, swipe slowly between
    tabs on the bar: the moving page's corners match the screen's own rounded corners. On an older phone they stay
    at 55. Report the phone and whether the corners line up.
60. **Share sheet** (from sync19b).
    - Signed in (sync connected to the Mac): in Chrome, open a page, then Share › Ardia. A sheet rises over Chrome
      with "Open in Ardia" and "Send to Your Mac" ("Your Devices" when another phone receives tabs). Tap Send to
      Your Mac: "Sent to …" shows and the sheet closes itself after about 1.4 s, Chrome still in front; the tab
      arrives on the Mac. Repeat with Ardia force-stopped first: the send still arrives (it waits up to 20 s for
      sync to load).
    - Share again and tap Open in Ardia: Ardia opens the page as a new tab.
    - Share plain text from a notes app: the sheet offers "Search in Ardia", which runs that search.
    - Signed out (sync off): sharing a page offers Open in Ardia and the sync hint, no Send.
    - Back or a tap outside closes the sheet; Chrome is untouched and Ardia doesn't appear in Recents.
61. **The tray follows predictive back** (from sync19b, Android 14 or later). Open the tray and swipe back slowly
    from the screen's edge: the tray moves down with the finger, up to 72 dp. Let go early: it springs back and
    stays open. Swipe all the way: it closes as Back did before. With the tray closed, Back works as before
    everywhere else (menus, dialogs, the Archive). Before Android 14, Back simply closes the tray.
62. **A cold share** (from sync20). Signed in, force-stop Ardia. In Chrome, open a page, then Share › Ardia › Send
    to Your Mac. "Sent to …" shows and the tab reaches the Mac although Ardia wasn't running. Share the same page
    again: the Mac gets one tab for each share, never two.
63. **A rotation in the middle of a send** (from sync20). Share › Ardia, tap Send to Your Mac and rotate the phone
    at once. The sheet comes back in the new orientation, and the Mac gets exactly one tab. Repeat with Ardia
    force-stopped first.
64. **Back with a menu or voice search over the tray** (from sync20). Open the tray, long-press a row so its menu
    opens, then press or swipe Back: the menu closes and the tray stays open; Back again closes the tray. A slow
    predictive-back swipe with the menu open doesn't drag the tray. The same with voice search open over the tray:
    Back closes voice search first.
65. **A camera request from a background tab** (from sync20). On a fresh install with no camera permission, open
    webcamtests.com in tab A and start the test, then switch to tab B before Android's dialog shows. No Android
    dialog while tab B is in front. Go back to tab A: Android's camera dialog comes up now, and the site's dialog
    follows once it is allowed. Close tab A while its request waits: nothing asks. Rotate while Android's dialog is
    up and answer it: the site's dialog still follows (or the request ends, if refused). The lab log has
    `PAGELAB page request camera from a page not on screen: Android is asked once the page shows`.
66. **A deck open right after a page paints** (from sync20). Load a page and open the deck the moment it paints.
    The card shows that page's picture at once, from memory, not an older one or a blank. The lab log then has
    `PAGELAB snapshot <id> landed in N ms: generation G`. Close and reopen the deck: the same picture, with no flash
    back to an older one.
67. **The budget line's two shares** (from sync20). After a fresh install or cleared data, open the deck and leave
    it idle for 4 s. The Look section's budget line gives two shares: work plus other main-thread work, and beside
    it the whole-frame share as judged through sync17b. Drag a card or open a sheet during the sample: the line
    says the sample was dropped, with the number of frames something other than the backdrop drew, or of frame
    reports lost, and nothing is stored. An idle sample must still come out conclusive. If it never does, report
    the line: the foreign-frame check is too eager.
68. **Back closes what is open, on every Android version** (from sync20b). With 3-button navigation, the ◁ key:
    - the page menu (⋯) open: ◁ closes the menu and the page stays;
    - Settings open: ◁ closes Settings, or goes back one screen from a sub-screen;
    - a confirm open (close all tabs in the deck, or clear history): ◁ closes it and nothing happens;
    - the tray open: ◁ closes it; with voice search over the tray, ◁ closes voice search first;
    - nothing open over the page and no page history: ◁ opens the deck, and ◁ on the deck reopens that tab, as
      Compose's does (BackOrder.next ends at the tab switcher; DeckState.back reopens the selected tab). Only on the
      start screen with no tab does ◁ send Ardia to the background. Reopen it from Recents and try the menu and
      Settings again: ◁ still closes them;
    - rotate with the page menu open, then ◁: the menu closes.
    With gesture navigation, the same with an edge swipe.
69. **Remove animations is followed while Ardia runs** (from sync20b). Open the deck: the blobs move. Without
    closing Ardia, turn on Settings › Accessibility › Remove animations (or Developer options › Animator duration
    scale › Animation off) and come back. The deck stands still at once, and the lab line reads `still (reduce
    motion…)`. Turn it off and come back: the blobs move again, with no relaunch. Open a sheet each time: it fades
    while the setting is on and springs while it is off. That half needs the screens' hook; until it lands, only the
    deck follows, and its line says `read natively`.
70. **The widgets take every change** (from sync20b). With both widgets on the home screen, change Settings › Color
    three times within a minute (Green, then Purple, then Neutral): the Search widget ends on Neutral within a few
    seconds and keeps it. Then Stop Syncing: Your Mac's Tabs shows its "turn on sync" message instead of the Mac's
    tabs within a few seconds, as the Compose app's does.
71. **One Android dialog for a site's location** (from the build after sync20b). On a fresh install, open
    openstreetmap.org and tap "Show my location". Android's location dialog comes first; choose Approximate and
    While using the app. The site's dialog follows; tap Allow. The map centres on you, and Android asks nothing more
    (no "change to precise" dialog).
72. **A fullscreen video turns with the phone** (from the build after sync20b). With auto-rotate on, play a video
    fullscreen and turn the phone: the video goes landscape and back. Exit fullscreen while landscape: Ardia goes
    back to portrait. With auto-rotate off, the video stays as the phone's rotation lock says.

#### R8 pass (sync19-r8 and later R8 builds)

`apps/phone/scripts/build-apk <name>` shrinks the release with R8 (`android.enableMinifyInReleaseBuilds`) since
sync20b; `--no-r8` builds the unshrunk control.
The keep rules are in `apps/phone/android/app/proguard-rules.pro`. R8's reports (`mapping.txt`, `usage.txt`,
`seeds.txt`, `configuration.txt`) land in `<name>-r8/` beside the APK in `/tmp/ardia-phone`.
ML Kit finds its parts through Firebase's `ComponentRegistrar` classes, made by reflection from their no-argument
constructor. R8 dropped `CommonComponentRegistrar`'s, so every release APK through 1.0.3-nightly.1 logged
`NoSuchMethodException: CommonComponentRegistrar.<init>` at launch and Gemini Nano never started, even on phones
Google lists. The rules keep every registrar's constructor and all of `com.google.mlkit` and
`com.google.android.gms.internal.mlkit_*`.
`apps/phone/test/r8/check-names.py <r8 apk> <unshrunk apk>` checks that what Android and the JavaScript reach by
name survived. R8 renames the libraries' classes, so a crash's stack trace names classes like `a.b.c`: run
`~/Library/Android/sdk/cmdline-tools/latest/bin/retrace <name>-r8/mapping.txt <trace.txt>` (or paste the trace into
Android Studio's "Analyze Stack Trace" with the mapping) to read it with the real names. Report the trace and its
retraced form together.

Start the pass where R8 is most likely to have broken something, then run the whole checklist:
1. Sync: connect with the phrase, scan the sync code with the camera, send a tab, receive one, open Spaces
   (serialisation, CameraX and ML Kit).
2. Background sync and widgets: add both widgets, change Color, leave the app in the background and check a tab
   sent from the Mac arrives (WorkManager, Room, Glance).
3. The share sheet, signed in and out (step 60).
4. What the native modules pass as structured values: the deck's page pictures, alert, confirm, prompt,
   permission and file-chooser requests, downloads, typing with inline completion (Expo's reflection).
5. Gestures and animation: deck scroll, tray drag, pull to refresh, swipe back and forward, the tray's predictive
   back (Reanimated, worklets, gesture handler).
6. Voice search, and the camera or video capture from a page's file chooser.
7. Fullscreen video (media3).
8. The lab: the deck-parts, frames and memory broadcasts and the Look section's buttons.

## Ardia Dev on Android

Every build without a release version (corex-build, build-apk without `--version`, lab builds) is a separate app, Ardia
Dev, `com.ardia.browser.android.dev`, so it installs beside the published Ardia (`com.ardia.browser.android`) and
neither replaces the other's data. Its activities keep their class names, so launch it with
`com.ardia.browser.android.dev/com.ardia.browser.android.MainActivity`. `--compose-key` builds keep the release package,
since they must install over the Compose app.

## Upgrade from the Compose app on Android

Both apps are `com.ardia.browser.android`, so the Expo app installs over the Compose app and finds its files.
Nothing in the Compose app's data is changed or deleted, so installing the Compose app back still works.

- **The gate** (`UpgradeGate.kt`, 9cc21830b). An import is pending while any Compose source (`databases/browser.db`,
  `shared_prefs/ardia.browser.xml`, `ardia.blocking.xml`, `ardia.reader.xml`) exists and
  `no_backup/PhoneSync/legacy-import.json` doesn't hold a valid, versioned receipt. While it is pending:
  - no sync controller is made (`ERR_IMPORT_PENDING`);
  - the browsing source refuses every read with `LocalBrowsingNotReady`, never an empty list;
  - `SyncWorker` retries instead of succeeding;
  - the page module makes no blocking or site settings;
  - links are queued, then delivered once, in order, when the gate opens.
- **The reader** (`PhoneLegacy.kt`, `ArdiaPhoneLegacy`, d0c0b4a79).
  - It copies `browser.db` and its WAL to `no_backup/PhoneSync/LegacySnapshot` and opens only the copy, so
    committed rows still in the WAL are read.
  - It runs `quick_check`, needs `user_version` 1 and every Compose column, and reports anything else as
    `unusable` (`schema`, `corrupt`, `locked`, `io`), never as empty.
  - `readLegacy` returns every tab and Archive entry with its saved state, the most recently active tab as
    selected, and the 14 JS-owned preference keys. `readVisits(afterId, limit)` pages history by id.
  - `applyNativeSettings` copies `ardia.blocking` into `ardia-blocking` (the same keys), splits `browsing.sites`
    into the zoom, Night Shade and app-links maps and their defaults, and copies the thumbnails of regular tabs and Archive entries
    into `files/PageSnapshots`. The thumbnail must sit inside `cache/TabSnapshots` and be a real image.
  - `markImportedWith(receipt)` applies those settings, writes the marker last, opens the gate and starts one
    sync. Every step can run again after a kill.
- **The importer** (JavaScript, `state/legacy/importer.ts`, shared with iPhone). The app starts only when the import
  is done or there is nothing to import; until then nothing runs: no tabs, pages, sync or links.
  - No source: nothing to do. A source done as an import: start. Otherwise the store's own decisions come first,
    even when the source is unusable or can't be asked: a valid receipt (`legacy.receipt` in the preferences
    table, version 1) means only `applyNativeSettings()` and `markImported(receipt)` run, so a kill between the SQL commit and the native
    marker finishes on the next launch. A source without one: import. The old `legacy.importVersion` marker no
    longer skips anything; `skipped-existing` is ignored and `1` (the old iPhone importer) counts as a receipt.
  - The import merges: a tab whose id is already in the store, or a setting already set, is kept as it is; the
    rest is inserted. Tabs, saved states (Archive included), thumbnails (Archive included), settings, history and
    the receipt commit in one SQL transaction. History arrives through `readVisits` in pages of 5,000 inside it.
  - Android ids are kept exactly, because thumbnails are named after them; iPhone ids are lowercased with their
    states and the selected tab. The old app's selected tab is selected after the import, over any newer tab the
    store already had.
  - The transaction stays open across `readVisits`; nothing else may write meanwhile, so the app's lifecycle
    and back handlers wait for boot, and the importer stops (`failed reason=write`) if it finds the transaction
    gone after a page.
  - Every record is imported or counted under a reason (`notWeb`, `duplicate`, `malformed`, `present`, and for
    settings `unknownKey`, `badValue`, `empty`). The source's counts must match what it reads, and the store's
    rows and setting values must match what was written, or the transaction rolls back. The log line
    (`ardia-legacy imported …` or `ardia-legacy failed reason=…`) holds counts and reason codes only.
  - It refuses the in-memory store (a store from a newer version): `failed reason=memory`, nothing marked.
  - Any failure shows a screen in place of the app: Ardia couldn't bring over the tabs and settings, they are still
    on the phone, Try Again. After a second failure, and only where the native module has `startFresh()`, it
    also offers Start Without Them: native opens the gate first, then `legacy.startedFresh` is recorded (not a
    receipt), and the app starts; if either fails the screen stays. The old data is left alone so a later
    version can still bring it over. A source `done` with outcome `startedFresh` starts the same way, and a
    receipt still finishes its native steps over it. Links that arrive while the screen is up run once, in
    order, after the app starts; each link's action finishes before the next starts.
  - Start Without Them calls `legacyImport.startFresh()`. On Android (248b3f68a) it first copies the blocking,
    filter and per-site settings when their files can be read (each file on its own, defaults when not; no
    thumbnails, no rows, as the iPhone does), then writes the marker with outcome `startedFresh` and no receipt, opens the gate, delivers held links and starts sync once, and touches no Compose
    file; `source()` then answers `done` with `outcome: "startedFresh"` (an import gives `outcome: "imported"`). A
    later `markImported` still imports over it. The iPhone (52379113c) does the same: a version 2 marker in
    `Application Support/PhoneSync/legacy-imported.json` with outcome `startedFresh`, the sync hold released and one
    sync requested, the SwiftUI app's store untouched. The blocking, filter and browsing settings it copied into
    the page module's suite at launch stay.
  - Per-site settings (1b33e2c47): hosts with blockers off join Trusted Sites, and a host's Desktop Site applies
    when a page enters that host. The Compose app never writes either flag to disk (Desktop Site lives only in the
    page), so a real upgrader has none to bring; the code handles them if they are there.
- **Names that must survive.** A placed widget, a pinned shortcut, the tile, a share target pinned in Android's share
  sheet and a job WorkManager queued all name a class, so the Expo app keeps every component the Compose app exports
  under the same name. The Compose app's `.share.ShareActivity` is an activity-alias of `.share.PhoneShareActivity`,
  and the alias is the only share target, so Ardia shows once in the share sheet. `apps/phone/test/r8/check-upgrade.py
  <compose apk> <expo apk>` checks the pair:
  - every exported component's name, kind, export and intent actions, and its class (or an alias's target) in the R8
    dex;
  - the widgets' provider meta-data and the launcher shortcuts' targets;
  - SyncWorker under its name, and WorkManager's Room identity hashes;
  - every database, preferences and key name the legacy reader opens.
- **Signing.** Android installs an update only when both apps have the same signing key and the new versionCode is
  not lower. The Compose debug build is signed with the building machine's `~/.android/debug.keystore`. The Expo
  app signs with `apps/phone/android/app/debug.keystore`, so for an upgrade it is re-signed with the Compose key
  (`apksigner sign --ks ~/.android/debug.keystore --ks-pass pass:android`). The Expo app is versionCode 2, the
  Compose app 1.

#### A Mac for a phone without one

The phones are on corex; the Mac is a hidden Ardia for Mac on shiv. `apps/phone/scripts/phone-sync-mac.mjs` runs on
shiv (a hidden instance with its own data folder and a sync folder in its work folder), and
`apps/phone/scripts/phone-sync-relay.mjs` runs on corex, where it keeps that folder and the phone's
`Documents/Ardia Sync` the same over ssh and the phone's own adb. Each has `start`, `status`, `sync` and `stop`
(`--help` on either). On corex, per phone:

```sh
S=<serial>; R=/Users/shivam-mini/.t3/worktrees/ardia/t3-ffb1082e-c9e4c64b1897b325; W=/tmp/ardia-upgrade-mac-$S
mac() { ssh shiv "cd $R && node apps/phone/scripts/phone-sync-mac.mjs $* --work $W"; }
relay() { node ~/phone-sync-relay.mjs "$@" --serial $S; }
scp shiv:$R/apps/phone/scripts/phone-sync-relay.mjs ~/phone-sync-relay.mjs
mac check                          # refuses an app older than this checkout's native API, and says what to run
mac start                          # prints the folder and the Mac's own device id; the phrase stays in $W/phrase.txt
relay start --mac shiv:$W/folder   # checks the phone's folder with a probe file, then mirrors every 3 s
```

- **The Mac app must match the checkout.** `mac check`, and `mac start` before it launches anything, refuse a
  Debug app whose binary is older than `packages/shell/ios/AppModule.swift` (where the native API version lives),
  or Pods behind `Podfile.lock`. Its JavaScript would otherwise stop at once with "native API skew: this JS bundle
  needs native API N, but the app was built with M". They print the commands that bring it up to date:
  `scripts/agent/locked pod -- sh -c 'cd apps/browser/macos && LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 pod install'`
  when the Pods are behind, then the `build-app --as phone-sync-mac` line from `--help`. pod install can re-quote
  `MARKETING_VERSION` in `apps/browser/macos/Ardia.xcodeproj/project.pbxproj`. If `git diff` shows only that,
  write HEAD's copy back (`git show HEAD:<path> > <path>`), so it never reaches a commit.

- `mac status` (or `mac sync` to sync first) prints every device the Mac sees with its id, name and kind, each
  device's open tabs, and the Mac's own tabs. `mac send https://example.com/x` sends a tab to the phone.
- `relay status` shows the last pass and the latest copies and deletions; `relay sync` runs a pass now.
- Connect the phone (Compose or Expo app): Settings › Sync With Mac › Connect to Your Mac. Step 1, Enter Words:
  the app has one field for all 24 words. Put the cursor in it and run `relay type-phrase`: it reads the phrase
  over ssh and types it through adb's standard input, so it never appears in a command, its output or a
  transcript. MIUI refuses injected text (`INJECT_EVENTS`), and `relay type-phrase` says so. The MIUI method, used
  on the F4 for upgrade14: a short script on corex reads the phrase with `ssh shiv cat $W/phrase.txt` into a
  variable and hands it to the test tool's own set-text action on that field (agentos `set_text`), printing
  nothing, so the phrase never reaches the screen, the log or the transcript. Never print the phrase or pass it as an argument.
  No screen read, screenshot, recording or accessibility dump is taken from the moment the phrase is in the field
  until the app has left Step 1. Neither app hides it there: the Expo field shows the words as typed
  (`keyboardType` `visible-password`, no autocorrect, autofill or spell check), and so does the Compose one
  (`KeyboardType.Password`, which keeps it out of the keyboard's learning but has no visual transformation). Only a
  private tab sets the Recents and screenshot protection. A screen read of that page captures the words. Step 2, Choose
  Folder…: in the system picker open Documents › Ardia Sync, then Use This Folder and Allow.
- When done: `relay stop`, then `mac stop` (it quits the instance and deletes `$W`), then
  `adb -s $S shell 'rm -rf "/sdcard/Documents/Ardia Sync"'` (the inner quotes are for the phone's shell, which
  would otherwise split at the space).

Checked without a phone: the Mac side started with the AGENTS.md rules (a Debug build, never the installed app,
`open -g -n`, `ARDIA_BACKGROUND=1`, a throwaway data folder), turned sync on, printed its phrase and devices, and
stopped cleanly. The relay ran on corex against shiv's folder with a stand-in for adb: copies, an idle pass,
deletions both ways and the loop. On shiv, a second hidden instance joined through the relayed folder with the
phrase; the Mac listed its id and its tab, and a tab sent from the Mac arrived once. On a phone: the connected
upgrade passed on the F4 (upgrade12, 9f37754cf's relay): probe, copies both ways, the same device id through the
import and every held kill. A file that vanishes between `find` and `stat` is now skipped rather than failing the
pass.

#### Upgrade tester script

Use the Compose APK and the Expo upgrade APK built for this run (same key), named here `$COMPOSE_APK` and
`$EXPO_APK`. Watch `adb logcat -s ReactNativeJS:I ArdiaJS PAGELAB` throughout (the lab's own lines are all under
`PAGELAB`), and `adb logcat -b crash` for crashes.
`P=com.ardia.browser.android`. The lab is `adb shell am start -n $P/com.ardia.browser.android.MainActivity --ez com.ardia.phone.PAGE_LAB true`,
then Upgrade; opening the lab never runs the import, and while the import waits its page area stays blank ("no
state"). A launch intent reaches a process that is already running, so to get from the app to the lab (or back)
force-stop first.

The kills, the failure screen and Start Without Them each end an import, so the script is three passes, each from a
fresh Compose setup (steps 1 to 3): pass A (steps 4 to 10: the reader, the kills, the import, a relaunch, Compose
back), pass B (step 11: the failure screen, then an import) and pass C (step 12: Start Without Them).

1. **Start from the Compose app.** MIUI refuses a fresh `adb install` (`INSTALL_FAILED_USER_RESTRICTED`), so
   install `$COMPOSE_APK` through the phone's own installer. If Ardia is on the phone, remove it in the phone's
   settings first (an Expo build has another key). `adb install -r` works over adb for every later update.
2. **Set up the Compose app as a tester has it.** Finish onboarding, then:
   - Open at least eight tabs and open the deck so each gets a thumbnail.
   - Archive two tabs (closing a tab archives it), one of them after going three pages deep. The Compose app keeps
     back history and scroll position only for archived tabs, not for open ones.
   - Visit about 30 pages. The Compose app has no History screen; history shows in search results.
   - In Settings: the color, search engine, search suggestions (off), auto-open keyboard (off), the auto-archive
     interval and Open App Links In (App).
   - In Site Settings: Night Shade (Automatic), swipe navigation, collapse bottom bar; zoom on one site and Night
     Shade on another; blocking: cookie banners off, a trusted site, a line in My Filters, one list off.
   - The Reader's size, serif and theme.
   - Connect sync. With no Mac of the tester's own, start the Mac on shiv and the relay as in "A Mac for a phone
     without one" (`mac start`, `relay start`) and leave both running for the whole pass. In the Compose app, connect
     with that phrase and Documents › Ardia Sync. Within a minute `mac sync` lists a `phone` device with the phone's
     name and an id, and its open tabs; the Compose app's Sync page lists the Mac. Send one tab each way:
     `mac send https://example.com/before-upgrade` arrives on the phone once, and a page opened on the phone shows
     under the phone's tabs in `mac sync`.
   - Not carried, because the Compose app doesn't store it: per-site Desktop Site (shown in the page menu but never
     written to disk) and open-in-app per site (there is no such control).
   Passes B and C need only a few tabs, one archived tab, a trusted site and a My Filters line.
3. **Write down the state.** Do this before anything else:
   - Screenshot the deck, the Archive, search results for an old visit, every settings page you changed, and the
     Mac's device list (Settings › Sync on the Mac, with the phone's device id in its detail; with the helper, save
     the output of `mac sync`, which has the phone's id and its tabs).
   - Run `adb shell am force-stop $P`.
   - Run `adb shell "run-as $P sh -c 'sha256sum databases/* shared_prefs/ardia.*.xml cache/TabSnapshots/*'"`
     and save the output. (`run-as` works only on the Compose debug build; the Expo build can't be inspected so.)

Pass A

4. **Install the Expo app over it.** `adb install -r $EXPO_APK`. Don't open the app yet.
5. **Reader check.** Open the lab, tap Read source and Read everything (`grep "PAGELAB upgrade"`):
   - The source is `pending`, with the tab, Archive and visit counts from step 2.
   - `read` shows every tab and both Archive entries, `states` at least the archived one that went three pages
     deep, `thumbnails` one per card that had a picture (Archive entries included), and `selected` the tab that
     was open.
   - `preferences` lists the keys you changed, and `visits` matches the source's visit count.
   - The lab's page area stays blank with "no state": the page engine waits for the import. Force-stop.
6. **A kill at each durable step.** A lab build can hold the import for 20 s at a step, through
   `--es ArdiaImportPause <step>`. Do these three in order, each from a stopped app:
   - `adb shell am start -n $P/com.ardia.browser.android.MainActivity --es ArdiaImportPause afterReceipt`. When logcat says
     `PAGELAB upgrade paused at settingsStart`, send a link to the held app:
     `adb shell am start -a android.intent.action.VIEW -d https://example.com/held-a -n $P/com.ardia.browser.android.MainActivity`. It does
     not open; the import is still waiting. Then run `adb shell am force-stop $P`. The SQL receipt is written, and
     the native settings and the marker are not. The link was kept on disk, so it survives the kill: it must open
     in step 7, once. (Don't send the link from a stopped app: that launch runs the import with no pause.)
   - The same with `afterSettings`, killing at `paused at settingsDone`. This launch finds the receipt, so it only
     applies the native settings (no `ardia-legacy imported` line). Send no new link: `held-a` from the first
     kill must survive this one and the next.
   - The same with `beforeMarker`, killing at `paused at beforeMarker`, again with no new link.
   Report the `ardia-legacy` and `PAGELAB upgrade` lines from each. With the helper, run `mac sync` after each
   kill: still only the step-3 phone id (a held import never makes a second device).
7. **The import.** Open the app normally. The import finishes from the receipt, nothing is imported twice, and
   `example.com/held-a` opens once, after the deck. Then check every item against step 3:
   - The deck has every tab in the same order, the same tab is selected, and each card shows its thumbnail.
   - The Archive has both entries with their thumbnails, and restoring the one that went three pages deep goes Back
     through them.
   - All the visits are there (History in the app, and search finds old ones), with no visit twice.
   - Every setting you changed holds: the color, search engine and suggestions, auto-open keyboard, auto-archive,
     Open App Links In, Night Shade, swipe, bottom bar, the Reader's size, serif and theme, each site's zoom and
     Night Shade, cookie banners, the trusted site, My Filters and the list you turned off.
   - Onboarding doesn't show (it does when the Compose app's onboarding wasn't finished).
   - In the lab, Read source gives `done` with `outcome imported`.
8. **The device the Mac sees.** On the Mac, the phone appears once, under the same name and device id as in step 3.
   It is not a second, new device. A tab sent from the Mac arrives, and one sent from the phone reaches the Mac.
   With the helper, after the import:
   - `mac sync` lists the phone under the step-3 id and no other phone, with the phone's tabs.
   - `mac send https://example.com/after-upgrade` arrives on the phone once, by itself, within about 20 s, with
     the app in front and nothing tapped (sync cycles every 15 s in front; sync11 and earlier needed Sync Now).
     Note the seconds from `mac send` to the toast. Not twice, not again after a force-stop and relaunch.
   - A page opened on the phone (`https://example.com/opened-after-upgrade`) shows under the phone's tabs in the
     next `mac sync`.
   - Settings › Sync With Mac on the phone shows it connected to the Mac, with no folder picker and no phrase
     asked for.
   Report the `mac sync` output from step 3, after the import, and after step 9, and the `relay status` lines.
9. **Relaunch with no second import.** `adb shell am force-stop $P`, then open the app twice. Each time, the deck,
   the Archive and History have the same counts as step 7 (nothing doubled), no `ardia-legacy imported` line, and
   `example.com/held-a` does not open again. With the helper, after the second relaunch, `mac send
   https://example.com/after-relaunch`: it arrives once, by itself, within about 20 s, as in step 8.
9a. **One tab per typed address** (the double tab after sync9's upgrade). With sync connected, open the tray and
   type `example.com/typed-after-upgrade`, then tap Go; then type `example.com/ime-after-upgrade` and submit it
   with the test tool's ime_enter. For each, `adb logcat -s PAGELAB` must show, in order, one
   `PAGELAB completion submit #n "…" via …`, one `PAGELAB completion js received submit #n "…"` with the same
   n, and one `PAGELAB tab opened … origin typed`; the deck gains one tab, and the next `mac sync` lists the
   address once. If two tabs open, report every one of those lines: two native numbers mean the field emitted
   twice, two received lines with one number mean the event was delivered twice, and a second `tab opened`
   line names the path that opened it (`origin received-from-mac` is a tab coming back through sync).
10. **Install the Compose app back.** `adb install -r -d $COMPOSE_APK`. It opens with the tabs, Archive, visits and
    settings from step 2, as if the Expo app had never run. Run the `sha256sum` from step 3 again: every line
    matches.
    Going back to a lower versionCode works only when the installed app is debuggable or the phone runs a
    userdebug or eng build. The Expo upgrade APK is a release build (not debuggable), so on a user build
    (`adb shell getprop ro.build.type` says `user`) `adb install -r -d` fails with
    `INSTALL_FAILED_VERSION_DOWNGRADE`, and `run-as` fails for the same reason; the F4 is such a phone. There,
    skip this step and the step-3 hashes. The evidence that the Compose files are untouched is then indirect:
    the reader copies the Compose database and the thumbnails it needs into its own folder and opens only the
    copies, never the originals (its `PAGELAB upgrade` lines), and the hashes and the Compose-back check come from a phone where the downgrade works; report which
    phone was which. Removing the Expo app (`adb uninstall $P`) deletes the Compose data with it.

Pass B (after steps 1 to 3 again)

11. **Failure screen, then an import.** `adb install -r $EXPO_APK`. Open the lab, tap Make source unusable
    (`source reports unusable (io)`; no Compose file is touched), then force-stop and open the app normally.
    - The "Couldn’t Bring Over Your Tabs" screen shows in place of the deck, and logcat has
      `ardia-legacy failed reason=unusable_io`.
    - Send a link while the screen is up:
      `adb shell am start -a android.intent.action.VIEW -d https://example.com/held-b -n $P/com.ardia.browser.android.MainActivity`. It does
      not open.
    - Tap Try Again: the same screen, now with Start Without Them and its note under it. Don't tap it.
    - Force-stop, open the lab, tap Make source usable, force-stop, then open the app normally. The import runs,
      the deck appears, and `example.com/held-b` opens once (it was kept across the restart). Compose back as in
      step 10: every sha256 matches.

Pass C (after steps 1 to 3 again, with a trusted site and a My Filters line set in the Compose app)

12. **Start Without Them.** `adb install -r $EXPO_APK`. In the lab, Make source unusable; force-stop; open the app,
    send `https://example.com/held-c` as in step 11, Try Again, then tap Start Without Them.
    - The app starts with no imported tabs (at onboarding when there are none), logcat has the started-fresh line,
      and `example.com/held-c` opens once. The trusted site and the My Filters line are there (blocking, filter and
      per-site settings are kept when they can be read); search suggestions are back to their default, because app
      settings come only with an import. Sync's page in Settings shows the Mac (sync runs), and a link sent now
      opens at once.
    - In the lab, Read source gives `done` with `outcome startedFresh`. Make source usable, force-stop and open
      the app twice: it stays started fresh, with no failure screen and no import.
    - `adb install -r -d $COMPOSE_APK`: the Compose app still has its tabs and settings, and every sha256 matches.

## Deck speed

Every interaction in a lab build prints one line, `PAGELAB perf <interaction> <window>ms | js … | ui … | renders … | look …`:
- js and ui are the frames each thread produced in that window (count, median, 90th percentile, worst, and frames over 1.5 budgets at 60 Hz);
- renders counts React renders by component;
- look gives the native look's recording, held layers and animations.

The render thread and the GPU don't appear there, so every run pairs the lines with gfxinfo over the same steps. The windows start at a deck pan (1.2 s), the deck's open (0.9 s), a card's open (0.9 s) and the tray's open (0.8 s).

#### The swipe into the deck (both phones)

The owner's reference is Safari's swipe up on its bottom bar (#2607; the measurements are in
`/tmp/ardia-b16/shots-before/REPORT.md` when that pass ran). What it does here:

- **The live page moves, not a picture.** The Pan on the bar (`barSwipeUp`) writes two shared values on the UI thread,
  `deckPull.shrink` and `deckPull.travel` (`state/browse/deckPull.ts`), and everything else derives from them in
  worklets: the page's transform (`PagePull` in `components/browsing/PagePull.tsx`), the deck's cards, backdrop and
  chrome (`useDeckPulled` in `components/tabs/deckPulled.ts`) and the bar's glyphs. No React render sits between a
  touch move and its frame. The geometry is pure and tested in `lib/deckPull.ts`.
- **The page is aimed at its own card.** `pullPagePose` takes the page from the full screen to the frame of its card in
  the deck (its slot in the stack, or its tile in the grid): width, centre and corner together. The shrink is spread
  over about a third of the screen's height of travel (`DECK_PULL.travelShare`, 325 pt on a Pro Max), so a flick lets
  go while the page is still moving; past that the page only rises a little, with resistance, and never gets smaller
  than the card, so the release finishes the same move and nothing turns round.
- **The page eases to the finger.** Each touch move sets where the page is heading and a stiff critically damped
  spring takes it there (`DECK_PULL.followResponse`, 0.12 s), so a fast flick, whose first touch move is already far
  up, can't jump the page there in one frame. The landing spring takes over from that spring with the page's own
  speed, whether or not the page had caught the finger up.
- **It opens centred.** The tab view opens with the current card centred and fully visible, from the swipe and from
  every `showDeck()` caller (`openingDeckScroll(index, count, true)`), on both phones. Android used to open with the
  newest tab one slot right of the focused card.
- **The deck is already there.** The deck waits under the page, laid out and parked off screen by a
  transform (not `display: none`, and never by opacity, which glass can't sit under), with the page in a layer above
  it (`PageLayer` in `App.tsx`). The waiting deck publishes the card's frame (`publishDeckStandby`); a swipe begins
  only when that frame is for the page's tab, and otherwise falls back to the tap path below.
- **Release.** `pullLands` commits on distance (90 pt past recognition, which is about Safari's 100 to 150 pt of whole
  travel) or on a flick of 900 pt/s; a drag back down at 250 pt/s always returns. The landing is a critically damped
  spring that carries on at the page's speed; the deck's header fades in on `deckPull.reveal` during it, as Safari's
  does, and the other cards slide out from behind the page on the same value (`pullTuck`): they wait behind it at
  80% size and full opacity, so nothing fades in and no frame carries a step. The deck is woken (unparked, cards
  drawn under the page) when the finger touches the bar, before the swipe is recognised, so the first drawing of the
  other cards is paid while nothing moves. Let go early and the page springs back; nothing was unmounted, so the page, its scroll
  position and the bar are as they were.
- **The handover never waits for a picture** (#deck-instant, 2026-11-22). The landing is a 0.15 s critically
  damped spring (0.18 s until round 4, which felt slow next to the press) that fires its completion when it is
  visually done (`energyThreshold` 1e-4, about 165 ms), not at rest; a flick's speed is capped so the spring can't overshoot the card. On that frame the live page is hidden and
  the deck's own card shown (`handOverDeckPull`), and the surface changes to the deck one frame later, so the deck
  takes over about 180 ms after the press (it was 730 ms on the iPhone simulator and 810 ms on the F4 before
  #deck-instant). It takes taps from the first frame of the landing: a tap on a card while the page lands
  (`hurryDeckPull`, caught by the pull blocker over the page) hurries the landing on a 0.07 s spring that carries
  on from the landing's own speed, so nothing jumps, and the tapped card opens as the deck takes over. The waiting
  deck publishes its cards' resting places with its target (`DeckHit`), and the tap picks the card whose resting
  place is under the finger (`deckCardAt`, which measures a pile card from its centred, scaled frame); a tap
  anywhere else is left alone. In Grid the waiting grid publishes no tile places yet, so a tap there waits for the
  grid to take over. A landing token makes the hurried
  landing's first spring, cancelled by the second, do nothing when it ends. Reanimated treats a spring to the same
  value as the same animation and keeps its constants, so the hurry aims a millionth past the card. Scrolling
  while the deck lands isn't taken: the scroll gesture lives in the deck, under the page, and handing a live pan
  across the switch was left for later. The page is unmounted in that same commit: keeping the shrunken live page over its card while the deck was
  the surface was tried and dropped, because the React commit that switched the surface reset the page's animated
  pose for one frame on both phones, a full-page flash. A card keeps the last picture that has loaded under any newer
  one until a newer one has loaded too (`TabFace`), so a new capture landing in the deck never shows the card's
  colour or its face in between, and a picture that has never loaded in this run shows the tab's face, never the bare
  colour. A card whose picture hasn't painted when the deck takes over is counted as `deck_pictures_late`; a tab
  that has never had a picture isn't. A picture taken for the deck never falls back to copying the window on Android
  (`windowCopy: false`), since by then the deck may be over the page. Each deck entrance carries a token, so a late
  capture or hold from an earlier entrance can't let go of a later one's page, and a second card tap while a grow
  is claimed is dropped. The 1.5 s in-flight clock of a pull starts at its release. The page's picture is kept current while the page is quiet
  (`keepFrontPictureCurrent`): on the idle callback 500 ms after the page settles (a load, a tab switch, a card open)
  and when the front page's scroll comes to rest, the page is copied if its picture isn't current. Never on a timer,
  so a page that keeps changing (a video) is copied once per settle, not over and over. A Tabs tap then finds the
  picture current and copies nothing. When it isn't (the first tap after a launch, or right after a scroll), the
  capture starts with the pull on iPhone: the on-screen copy is synchronous and holds the first frame about 33 ms
  on the simulator (first frame 48 ms). Moving that copy to the frame after the motion starts was tried and dropped:
  it became a 60 to 80 ms frame in the middle of the landing. Taps that copied at the press are counted as
  `deck_pictures_at_press`. On Android a pull never copies the page: the card shows the picture kept current while
  the page was quiet. Copying it once the landing had started (the draw runs on the main thread, 20 to 60 ms on the
  F4, so it could not go before the first frame) dropped the moving page for one frame on the F4 when the page had
  a video playing, showing the tucked card behind it: 5 in 45 landings with GitHub Explore in front, against none
  in 30 without the copy and none on main. No other copy of the page in front (a load's settle timer, the leaving
  picture, the quiet-page copy) runs while a pull or a card's growth is in flight, on either phone: on Android it
  would drop the moving page, and on iPhone the synchronous copy stalls a landing frame; the settle timer retries
  once the pull is over. A capture is skipped when the page reports its picture still current
  (`snapshotIsCurrent`). A second request for the tabs while a landing is in flight is ignored; one whose landing
  never reported back stops being in flight after 1.5 s, so a lost callback can't leave the Tabs button dead.
  The live page and its picture agree to the point because the page
  view pins its insets while it moves (`pinsSafeArea` on `ArdiaPageView`): a transformed view's safe area shrinks as
  it leaves the status bar, and the web view's content used to slide inside the page by up to 60 pt during the pull.
- **No second motion.** When the "Archive inactive tabs" capsule is due, the waiting deck lays its cards out for it
  before the pull (`archivePlanned`), the page lands on the shifted card, and the capsule is offered at once at the
  handover (`offerArchiveCardNow`) and fades in over cards that don't move. The capsule's behaviour at other times
  is unchanged.
- **One bar.** The two bars have the same three shapes (48 pt circle, capsule, 48 pt circle; the deck's sits 0.5 pt
  lower). The browsing bar's glass stays for the whole pull and moves that 0.5 pt with it. Its glyphs fade out as the
  page's bottom edge rises 8 to 44 pt and the tab view's glyphs (the Incognito eyes, Search Tabs, +) fade in on the
  same glass from 36 to 66 pt (`PullGlyphs`, `PullGhost`). When the page's bottom edge has cleared the bar the deck's
  own bar takes over in one React commit (`usePullBar`): its glass on, the browsing bar's glass and ghost glyphs off.
  It gives the bar back the same way if the finger comes down again.
- **The tap is the same motion.** `showDeck()` lands the page from rest through the same worklets
  (`landDeckPullFromRest`) when a page is showing and the pull is armed. The waiting deck is mounted when the page
  goes quiet: 500 ms after it settles, past the search tray's departure, then on the next idle callback
  (`whenIdle`), where it was a fixed 600 ms, and its held state is
  refreshed the same way after a tab switch. If it still doesn't hold the page's card, the tap asks it once and waits
  one frame; when that isn't enough (the page is covered, or the deck isn't ready) the old entrance runs at once and
  shrinks the card on the next frame, with no wait for its capture or its picture. On Android, where that entrance
  keeps the page under the deck, the page's capture is taken when the shrink has landed and the page unmounts after
  it (at most 400 ms).
- **Opening a card is the reverse.** The deck's own card grows from its place on the same
  values (`growDeckPull`, response 0.15 s, like the landing), the other cards tuck in behind it, the header's glyphs fade out, and
  the live page is mounted only once the card has landed (mounting it mid-growth stalled the growth for over 100 ms)
  and takes the card's place as soon as it is laid out, without waiting for its cover's picture to paint. The
  growth hands over from its spring's completion (about 200 ms), with a 600 ms fallback if that never reports, and
  a grow the UI thread refuses hands over at once. The bar then cross-fades back to the page's in 150 ms. In Grid a tile still opens with the older cut. The separate opening card is now only used in the classic design.
- **Grid.** With Grid chosen the waiting deck holds the grid, centred on the page's tab, and the target is that tile.
- **Reduce Motion.** Nothing tracks the finger, nothing moves and nothing waits (#2647). What the swipe and the tap
  do depends on what the page's card can show at once:
  - **Its picture is painted** (the usual case): the page cross-fades over the deck at rest in 150 ms, starting in
    the frame the request is handled (`fadeDeckPullFromRest`, with `ReduceMotion.Never`, since Reanimated otherwise
    skips the fade and cuts). When the fade ends the deck takes over at once and the fresh capture replaces the
    card's picture when it has loaded.
  - **It has no painted picture** (a page never captured, or a newer picture the waiting deck hasn't drawn): no
    fade. The page is cut into its card (`cutDeckPullFromRest`) and the deck takes over on the next frame.
  The waiting deck takes each new picture of the page in front as it lands (`showHiddenDeckThePicture`), so the
  first case is the common one. It does so with normal motion too: when it didn't, a card whose stored picture
  failed to load (the first launch after an update on iPhone) showed the tab's face for two frames at the
  handover before the fresh picture drew. A touch on the bar wakes the deck under the page and draws the page at 99% (`deckPull.primed`), which makes
  the compositor draw both before the fade: without it the first fade after a launch stalled about 90 ms and
  showed in two frames. The bar keeps the browsing glass through the fade, with the tab view's glyphs fading in on
  it, and the deck's bar takes over after. Opening a card is a fade too (`growDeckPull(…, steady)`): the deck holds
  still, can't be dragged or scrolled by an accessibility action, and stays the surface, the page is made under it unseen, fades in over it once it is laid
  out and its cover has painted (five to seven frames after the tap on the simulator), and the deck lets go when
  the fade has ended. The fade's end commits the opened tab only if its opening is still the active one: if a link
  or anything else has put another tab in front meanwhile, the open is cleared and that tab stays selected (#2664). Grid's tile open, and the old entrance when it runs (search, a menu or the reader open, or
  the deck not ready within 0.5 s), are still cuts under Reduce Motion.
- **A request that outlives its page is dropped.** If the tab in front changes, or the surface does, while a tap
  is still waiting for the deck to report (one frame), the request is cleared and nothing opens; with the same
  page still in front it falls back to the old entrance.
- **Android takes the same pull** (the owner, 2026-11-19: all of iPhone's deck and page parity on Android except
  Material You). Every piece above is shared: the Pan on the bar, its 22 pt recognition and 90 pt or 900 pt/s
  commit, the page layer over the waiting deck, `useDeckPulled`, `PullGlyphs`, `PullGhost`, `usePullBarShift`, the
  landing, the handover, the card growing back and the Reduce Motion fade. Android's differences are only where its
  platform differs:
  - the card's corner the page shrinks to starts from the display's own corner (`screenCornerRadius`), as the pager's
    does, rather than iPhone's fixed one;
  - the page view doesn't pin its insets: `pinsSafeArea` is iPhone's alone, because an Android view's window insets
    don't change when it is transformed, so the page and its picture already agree;
  - on Android's solid chrome, the browsing bar keeps its place through the pull and cross-fades to the deck's
    glyphs. It holds those glyphs until the deck takes over, so there is no intermediate swap to an empty bar;
  - the deck's bar, and the start page's, sit exactly where the browsing bar does (`floatingBarCenter` in
    `lib/deckGeometry.ts`, one place for all three): 21.5 dp above the screen's bottom over a gesture handle, or 8 dp
    above a 3-button bar, so the bar doesn't move during the pull. iPhone's deck bar keeps its place over the home
    indicator, 0.5 pt lower. The deck's bar used to sit 11 dp above the gesture inset on Android, low enough that
    MIUI's gesture handle sat on Search Tabs. When the keyboard is up, Search Tabs rises to 8 dp above the keyboard's
    top, measured from the window's bottom, so the navigation inset isn't counted twice.
- **Nothing lands after its page has gone.** A cancelled touch (the system taking the gesture, or the bar turning off
  mid-swipe) ends the Pan with `success` false and always returns. A pull still tracking when its gesture
  finalizes without an end, when its page view unmounts or when the tab in front changes (`abandonDeckPull`, from
  the Pan's `onFinalize` and from `disarmDeckPull`) springs back too; a landing whose page is no longer in front when
  it settles hands over nothing (`enterDeckFromPull`).
- **Back.** Android's Back does nothing while a pull is landing, waiting for the deck or handing over
  (`deckPullCommitted`), so it can't take the page back a step as it shrinks into its card; during the tracking and
  the return it behaves as on a page at rest.
- **Landscape** takes the pull too, aimed at the landscape card. The closed and open Duo take it as any iPhone does
  (#2840); `wide` and `split` never show the deck.

In a lab build every pull prints `PAGELAB perf deck pull <ms>` for the time under the finger, then
`PAGELAB perf deck pull landing 900ms` (or `deck pull return`). A tap prints only the landing line. On iPhone `labLog`
now goes to the unified log through `NSLog` in test builds (`ArdiaPhoneSystem.labLog`), so the lines can be read with
`xcrun devicectl device process launch --console …` or
`log stream --predicate 'eventMessage CONTAINS "PAGELAB"'`; before this they went to `console.log`, which a Release
build drops.

To measure without a finger, launch a lab build with `-BrowseDeckPull <n>`: once a page is showing and the deck is
waiting, it replays a fixed finger path through the gesture's own worklets (`replayDeckPull`): n pulls of 220 pt in
0.35 s released at 630 pt/s, each followed by opening the same card again, then one pull of 50 pt let go at rest,
which returns. It ends with `PAGELAB deck pull script done: <committed> of <n> committed, <returned> returned`. It
works on whatever tabs are open and leaves the same tab selected; with no page showing it only logs.

#### Deck speed tester script (lab build)

Run it once with the look off (lab › Look) and once with it on, at animator scale 1. `$P` is the package. Swipes are in pixels for a 1080-wide screen; scale them for others.

The tab count is part of the run. Deck speed depends on it: with up to 19 tabs every card stays mounted, and with more the deck mounts cards as it moves (sync19 ran 26 tabs against sync16's 9, and its deck scroll looked twice as slow for that reason alone). So:
- State the count before you start: 9 unless the brief says otherwise (26 for a large deck). Every tab must have a picture: open each site and wait until it has loaded, then launch with `--es ArdiaDeck "warm"` and wait until the `PAGELAB snapshot` lines stop.
- Check it before every measured step: each deck open logs `PAGELAB deck shown with N tabs, M private`. If N isn't the stated count, or M isn't 0, fix the tabs before measuring; tabs sent from a Mac or opened by an earlier check count too.
- Print it with every result: `tabs=N (checked HH:MM:SS from the deck line)` at the top of each gfxinfo and perf file, and the count in the report's table. Two runs with different counts aren't compared.

1. `adb logcat -c`, then `adb shell dumpsys gfxinfo $P reset`.
2. Deck scroll: open the deck. Five times, `adb shell input swipe 860 1300 220 1300 300`, then 1.5 s idle; then five times the other way, `adb shell input swipe 220 1300 860 1300 300`. Save `adb shell dumpsys gfxinfo $P > scroll-<look>.txt`.
3. Reset gfxinfo. Deck open: from a page, tap the Tabs button, wait 1.5 s, tap the focused card, wait 1.5 s. Repeat five times. Save gfxinfo as `open-<look>.txt`. The same loop gives both "deck open" and "card open" lines.
4. Reset gfxinfo. Tray open: from a page, tap +, wait 1.5 s, Back, wait 1.5 s. Repeat five times. Save gfxinfo as `tray-<look>.txt`.
5. `adb logcat -d -s PAGELAB | grep "PAGELAB perf" > perf-<look>.txt`.
6. Report from each gfxinfo file: janky frames %, 50th and 90th percentiles, GPU 50th percentile, "Number Slow UI thread" and "Number Slow issue draw commands". From the perf lines, the median js and ui p50 per interaction and the renders.

#### Timing opens and launches from a recording

Time a deck open, a card open, a flick or a cold start from a screen recording only with `apps/phone/test/phone-runs`'s
`rec.sh`, `vtool.py` and `opentimes.py` (the phone-runs README has the commands). They take every frame's time from
screenrecord's own per-frame stamps and every touch from the phone's input log. Recordings timed from the moment
screenrecord was started are off by however long its encoder took to deliver the first frame, 235 to 590 ms and
different on every recording (found on the M3 on 2026-11-16), so their times don't compare between recordings or
visits. **Open and launch timings measured on the M3 before 2026-11-16 are not comparable**: the testers' openana.py
used that clock, including the expo58b runs that read the upgrade as faster. The F4's runs used the frame stamps and
stand.

#### Against the Compose release (F4, 2026-11-15)

One session on the F4, medians, the Compose app's release build (OLD) against sync23 (React Native 0.81) and expo58b
(Expo 58). From `/tmp/ardia-phone-shots/expo58b-f4/table.txt`.

| Row | Compose release | sync23 | expo58b |
| --- | --- | --- | --- |
| Cold start, `am start -W` | 308 ms | 300 ms | 328 ms |
| Cold start to usable (the tray up) | 905 ms | 1,236 ms | 1,198 ms |
| Deck open, first shrinking frame | 156 ms | 450 ms | 272 ms |
| Deck open, settled | 443 ms | 762 ms | 583 ms |
| Card open, first moving frame | 93 ms | 128 ms | 132 ms |
| Card open, settled | 410 ms | 678 ms | 608 ms |
| Card open, longest frame gap | 17 ms | 113 ms | 87 ms |
| Deck scroll, nine tabs, janky | 7.9% | 3.0% | 3.3% |
| Deck scroll, 26 tabs, janky | 8.8% | 18.9% | 20.8% |
| Memory, nine tabs | 333 MB | 432 MB | 432 MB |
| Installed size | 26.2 MB | 73.5 MB | 52.6 MB |

Known gap in the opens, **the card open's tail**: in 6 to 11 of 15 card opens per build (the M3's bisect, expo58b and
expo58c alike), one more change lands 500 to 650 ms after the card starts moving, when the live page replaces the
card's picture. The other opens settle about 220 ms after they start moving. That second change is the F4's card open
settling at 608 ms against Compose's 410, and its 87 ms held frame against Compose's 17. The rest of the gaps, largest
first: the 26-tab deck scroll, the deck open's first frame (+116 ms), cold start to usable (+293 ms) and memory
(+99 MB with nine tabs).

#### Deck parts (lab build, from sync17)

To find what a deck frame costs, take the deck's parts away one at a time while the backdrop repaints at its
pace (lab › Look › Backdrop: flat colour, budget forced full), and measure each with the idle gfxinfo and
framestats. `adb shell am broadcast -a com.ardia.phone.DECK_PARTS -p $P --es part <part>` logs
`PAGELAB deck parts: …`: what it changed, then an inventory of the shown views (how many are drawn offscreen
every frame because they are partly transparent and overlap with no layer, listed by size and alpha; hardware
layers and their pixels; views with elevation; outline and overflow clips; image views and how many are
pictures; fade views; look views) and the parts applied so far. Parts accumulate until `restore`:
- `inventory`: the inventory only, nothing changed;
- `shadows`: elevation and translationZ set to 0;
- `clips`: clipToOutline off and overflow-hidden views set visible;
- `snapshots`: image views 100 dp and wider hidden (the page pictures, not favicons);
- `alpha`: the partly transparent views made opaque, so none is drawn offscreen;
- `layers`: the same views held on hardware layers instead (keeps their alpha);
- `bar`: the deck bar's plates hidden;
- `headers`: the card headers (fade views) hidden;
- `restore`: everything put back.
JavaScript re-renders can put a prop back, so apply a part on the settled deck and measure right away.

## The look's budget

The look (the deck's moving blobs and the frosts) must cost a phone no more than it can carry. A phone measures
it once and turns the look down if it can't; the system settings always come first.

- **What is measured.** The first time the deck is built after an install or an update, `useLookBudgetProbe`
  (called by the deck with whether it is idle) skips the deck's first second, then takes 2 s of the app's own
  frame times while the deck stays idle (no scroll, drag, sheet, menu, tray or card opening). Each frame counts
  what it cost (Android's `TOTAL_DURATION`, from its vsync to the GPU finishing it) against its own deadline
  (`DEADLINE`, the frame timeline's, about 1.4 refresh intervals on a 120 Hz panel), but only while that
  deadline is within 1.5 intervals of the display's refresh rate, read once at the sample's start and never
  slower than 60 Hz. A deadline the system stretched (a halved frame rate) is held to one interval, so a slow
  phone can't pass because the system lowered its rate. A paced deck that skips vsyncs is judged only by the
  frames it draws. An idle deck with
  the look off draws no frames at all, so every frame in the sample is the look's own. A sample that overlaps
  anything else is dropped, and one deck open gives at most one measurement.
- **The verdict.** A sample is over budget when the look keeps the phone busy more than a third of the time,
  or when its median frame's work is longer than the pace it was drawn at (it cannot keep up at all).
- **What busy counts** (from sync20). Each frame's work: FrameMetrics `TOTAL_DURATION` less
  `UNKNOWN_DELAY_DURATION`, which in `dumpsys gfxinfo … framestats` columns is `FrameCompleted − IntendedVsync`
  less `HandleInputStart − IntendedVsync`, so from the moment the UI thread starts the frame to the GPU
  finishing it. Plus all other work on the main thread during the window: every message the main Looper
  dispatches except Choreographer's frame message, timed through `Looper.setMessageLogging` (`MainThreadWork`).
  The wait left out is only the time between the vsync and the UI thread starting the frame. Our own work
  can't hide in it. A native tick, a posted runnable, a React Native mount or anything else the main thread
  runs is a message, so it is counted as main-thread work whether or not it delayed a frame. Work inside
  the frame, such as Reanimated's and Fabric's frame callbacks, is in the frame's work. JavaScript runs on its
  own thread and reaches the main thread only as one of those. What remains in the wait is the system's
  delivery of the vsync, which on the F4 at 120 Hz was 4 to 8 ms a frame (sync17b) and varied from window to
  window. The line also prints whole frames over the window, the share every run through sync17b was judged on
  (`… busy B% of the time (whole frames, as judged through sync17b: W%)`), so a run can be read against the
  F4's 19 to 30% and the M3's 29%. From sync21 the lab's line breaks the other main-thread work down: how many
  messages, the backdrop's ticks against the rest, and the three longest messages by their handler and callback
  (`… other main-thread work 241.7 ms in 412 message(s): backdrop ticks 3.2 ms, the rest 238.5 ms; longest …`).
  Our own callbacks are named whatever R8 does (`ardia deck tick`, `ardia deck scene hand-back`). Other messages
  keep their full class names, which on a shrunk build read like `j6.s what 3`; `retrace` with the build's
  `mapping.txt` gives the real ones.
- **How busy is formed** (from sync22). Busy = (Σ each frame's work + the main thread's other messages + the
  backdrop's scenes drawn on the worker thread) / the window. The worker's time is the look's work on another
  core and counts the same as the main thread's; the line prints it as `… scenes drawn off the main thread in N ms
  (counted)`.
- **How often a scene is drawn** (sync22, reworked in sync23). With the blobs paced (the default), the worker draws
  a scene every 400 ms and keeps one more drawn ahead, so the next scene is ready before the fade needs it. On each
  frame (every 75 ms, on a fixed timeline so the pace is what was asked) it blends the two scenes at the small
  picture's size, and the deck draws that one picture scaled up, as before the fade. If a scene is ever late, the
  fade holds at the scene it reached and goes on from there when the scene lands; it never jumps ahead. A blend
  halfway between two scenes 400 ms apart is 0.042/255 a channel from the true scene at that moment, less than one
  old 43 ms frame step changed it (0.047, SceneOffMainTest on this machine). The lab's fixed blob rates (`Blobs N
  fps`, `every frame`) keep one scene per frame, drawn on the worker, as the yardstick. The sample lasts 3 s, so a
  frame every 75 or 100 ms still gives the 20 frames a verdict needs, and the line counts the scenes and blends
  drawn in it.
  The verdict uses busy, against the same 33%. It decides nothing under 20 frames unless those few frames are already over.
  Why a duty cycle: an idle deck's paced frames, drawn between vsyncs while nothing else moves, make nothing
  stutter that a person can see. What they cost is battery and heat, and that is the share of time the GPU
  and CPU spend on them. The sum counts every frame, slow ones included, since heat is the total. The keep-up
  check uses the median, so one slow frame can't fail a phone. Each frame's own deadline, held to the
  display's refresh, is still reported but decides nothing. Two over-budget samples on separate deck opens
  degrade the phone; one good sample between them starts the agreement over.
- **What degraded means.** Frosts become their fills and the deck stands still, by the same paths Reduce
  Transparency and Reduce Motion take, which leave nothing behind (no recording, no blur layer, no redraws). Reduce
  Motion and Reduce Transparency always turn their half off whatever was measured; the measurement can only take
  the look away.
- **Never in front of the user.** A verdict is stored at once but each look view reads it when it is built, so it
  shows the next time the deck (or a sheet with a frost) is built, never mid-session.
- **A second chance.** A passing phone is measured again after an app update; a degraded one after an update or
  30 days, by showing it the full look for the next builds until two samples agree again.
- **Telemetry.** One enum, `look_mode` (`full`, `no_blur`, `no_motion`, `neither`, from `lookBudget.mode()`), on
  `app_launched`: the look this launch shows, system settings included. No frame time leaves the phone. The deck
  calls `useLookBudgetProbe` through `DeckLookProbe`, idle while the deck is settled and untouched with no sheet, menu,
  confirmation or tray, and passes the system's Reduce Motion and Reduce Transparency.
- **The lab.** Look shows the verdict, the next build's look and the last sample (frames, median against
  deadline, share missed) and can force full, force degraded, go back to measured, or reset. Lab builds log
  `PAGELAB look budget over|within|inconclusive: …` for each sample.

**What the Codex review of 15 November changed.**
- A sample has one owner. A new one cancels the old one, whose late timer touches nothing. The sampler chains onto
  any Printer already on the main Looper and puts it back after. Setup that throws cleans up and answers once. JS
  cancels a running sample when the probe stops. A sample that lost a frame report decides nothing (4e77b8375).
- A frame is the backdrop's own only when no other view asked for it. Every traversal walks the views the backdrop
  doesn't explain, meaning anything other than itself, the views it just put on layers, its frosts and their
  parents. Any of those that is dirty, or that moved, scrolled or changed alpha since the last traversal, makes
  the frame foreign. RenderThread-only animations such as ripples stay unseen (61b71906b).
- The ticks stop and the resting layers are released when the deck is hidden or its activity stops, the look is
  off, reduce motion, reduce transparency or a degraded budget stills it, or the hidden app releases the look, not
  only on detach (61b71906b).

Shared and per-phone parts:
- Shared, in TypeScript (`packages/phone/src/lookBudgetRules.ts`): judging a sample, the two-sample agreement,
  the verdict per version, the re-measure, the system settings, the telemetry enum and the probe's timing (skip,
  idle only, one per open). `lookBudget.ts` keeps the state and gives the hook and the lab their calls.
- Each phone supplies five calls on `ArdiaPhoneLook`, and makes its look views read the stored `apply`
  ("full" or "degraded") when they are built:
  - `sampleFrames(ms)`: resolves `{ totals, deadlines, refreshMs? }`, one entry per frame the app drew in that
    window, in milliseconds, and the display's refresh interval read at the start (Android:
    `Window.OnFrameMetricsAvailableListener`, `TOTAL_DURATION` against `DEADLINE`, or the refresh interval
    before Android 12, and `Display.getRefreshRate`; iPhone: a `CADisplayLink`'s frame times against its target
    time; without `refreshMs` each frame keeps its own deadline);
  - `lookBudget()`: `{ state, version, forced }`, the stored state as JSON text, the app's version (with the
    build commit, so a lab build counts as an update) and a lab force or null;
  - `setLookBudget(state)` stores the JSON;
  - `forceLookBudget("full" | "degraded" | null)`, lab builds only;
  - `cancelSampleFrames()` ends a running sample, which then resolves null. A sample also carries `foreignFrames`,
    `waits`, `tickMs`, `mainThreadMs` and `droppedReports` where the phone has them.
  Android has all of it (`LookBudget.kt`); the iPhone half is not built yet.

## Browse for Me

Arc Search's answer page, written on the phone. On iPhone it came from the SwiftUI app (PR #1724, `ios-browse-for-me`)
and keeps that app's Swift: the logic in ArdiaKit's `ArdiaBrowser/Research` and `ArdiaBrowser/ChatGPT` (with
`ResearchTests` and `ChatGPTTests`), and the session, the answer page, the ChatGPT account and the settings page in
`packages/phone/ios` (`ResearchSession`, `ResearchPageLoader`, `ResearchView`, `ChatGPTAccount`,
`LoopbackCallbackServer`, `KeychainSecret`, `BrowseForMePage`). Android ports the same logic to Kotlin in
`packages/phone/android`: `com.ardia.research` (search, digest, answer) and `com.ardia.chatgpt` (sign-in, tokens,
identity, Responses), with `ResearchSession`, `ResearchPageLoader`, `ResearchScreen` (Compose), `ChatGPTAccount`,
`LoopbackCallbackServer`, `OnDeviceWriter`, `BrowseForMeHost` and `BrowseForMeModule` in `com.ardia.phone`. The
JavaScript is shared; it turns on wherever the native module is registered.

- **Where it starts.** Typing a plain search (three letters or more, not an address, not a bang) adds a Browse for Me
  row under the typed query (`withBrowseForMe` in `state/search/omnibox.ts`), and voice search has a Browse for Me
  button beside Search once it has heard words. Incognito changes nothing, and nothing is saved to history.
- **The bridge.** `BrowseForMeModule` (`ArdiaPhoneBrowseForMe`) has `open(query)`, `isConnected()`, the
  `onBrowseForMe` event and the `BrowseForMeSettingsView` view. `BrowseForMeHost` owns the one `ChatGPTAccount` and
  the open `ResearchSession`, and presents `ResearchView` full screen in a `UIHostingController` over React Native's
  root. What the SwiftUI page took from `AppModel` comes back to JavaScript as events (`state/browseForMe/events.ts`):
  `openSource` (a source opens as a normal tab), `searchWeb` (Search the Web), `openLink` (Check Usage closes Settings
  and opens chatgpt.com's usage page), `settled` (the outcome, for the counts below), `account` (ChatGPT connected or
  not, for the Settings row) and `closed`. The hidden page readers use the page engine's content blocker.
- **Reading.** DuckDuckGo's HTML results with a plain request (DuckDuckGo shows WebKit a bot check), the first five
  readable pages (one per site, no video or social sites), three at a time in hidden web views with a throwaway data
  store and the Reader's extraction (8 s each). On Android the throwaway store is its own WebView profile
  (`ardia-research-<uuid>`, never the normal or the Incognito one), deleted when the pages are read or the page
  closes, with leftovers swept on the next use. A WebView without profiles (`MULTI_PROFILE`) never renders the page
  at all: the HTML comes from a cookie-less request and is read as an inert `DOMParser` document in an
  `about:blank` WebView that blocks every network load, so no page script runs. Page text is untrusted: the
  instructions tell the model never to follow what the pages say.
- **Writing.** Apple Intelligence on the iPhone (`SystemLanguageModel`, Foundation Models) is the default: a short
  answer with `[n]` citations from the pages' most relevant paragraphs, cut to fit the model's context. Without Apple
  Intelligence (an older iPhone, turned off, still downloading), or when the model refuses, the answer is the pages'
  most relevant sentences, cited, and the page says why. The sources sit in a row above the answer. On Android the
  on-device writer is Gemini Nano through ML Kit's Prompt API (`com.google.mlkit:genai-prompt:1.0.0-beta4`, pinned:
  beta4 ships Kotlin 2.3 metadata, which React Native 0.88's Kotlin 2.2 still reads; beta5 ships 2.4, which it
  doesn't). Google opens the Prompt API to apps only on the phones it lists (Pixel 9 and newer, Galaxy S25 and newer,
  the Z Fold7 and Flip7, and a few other flagships), so a phone can have AICore installed and still answer
  `UNAVAILABLE` (a Galaxy S24, a POCO). `OnDeviceWriter.Availability` keeps the reason apart instead of calling every
  miss "can't run": `NotOffered` (the status is `UNAVAILABLE`, or AICore throws `NOT_AVAILABLE`), `Downloading`
  (it starts the download and shows excerpts until it lands), `NeedsUpdate` (`AICORE_INCOMPATIBLE`,
  `NEEDS_SYSTEM_UPDATE`), `NeedsSpace`, `Busy` (`BUSY`, the per-app quota, `BACKGROUND_USE_BLOCKED`), `Failed`,
  `DownloadFailed` (AICore's download stopped; the next check reports it once and starts it again) and `WriteFailed`
  (the status said available but both writing attempts failed; an AICore error code there keeps its own reason, so a
  quota refusal reads "busy").
  A busy or failed status check is asked once more after 400 ms, and a client that couldn't be made is made again on
  the next use instead of being remembered as missing. The note names the reason, for example "Google lets apps use
  Gemini Nano only on newer phones, such as the Pixel 9 and Galaxy S25, so here are the most relevant lines from the
  pages." (`OnDeviceWriterAvailabilityTest`).
  `OnDeviceWriter.download` is a process-wide `StateFlow` of the model download: a `DOWNLOADABLE` status collects
  `download()` for its progress, and a `DOWNLOADING` status (AICore already fetching it) is polled every 5 s for up to
  30 minutes. While an excerpts answer was written because Nano was downloading, the note is followed by
  "Downloading Gemini Nano… n%", then a Rewrite with Gemini Nano button once it lands. A search with ChatGPT
  disconnected, and every page summary that will use the phone's model, start `OnDeviceWriter.prepare()` alongside
  reading the pages: it checks the status (starting a download early) and calls `warmup()` so the model is loaded
  before the prompt is ready. The answer is capped at 256 tokens. The prompt starts from the token limit at about 4
  characters a token, `fit` counts it with `countTokens` and shrinks it (up to 3 times) until it fits, and a failed
  write is tried once more at half that size. Generation
  never leaves the phone, but ML Kit itself reports anonymous API usage to Google.
- **Continue with ChatGPT.** Settings › Browse for Me (and a button under an on-device answer) signs in with OpenAI's
  Sign in with ChatGPT plan-usage flow, so answers come from the user's own Plus or Pro plan, straight from the phone,
  never through a server of ours. It mirrors OpenAI's devkit: discovery, `dynamic_agent_client` with
  `agent_name_hint` on the first sign-in (the issued `oaiapp_…` client ID is saved per issuer and reused), S256 PKCE,
  state, nonce and `resource=https://api.openai.com/v1`. The redirect is the documented loopback
  `http://127.0.0.1:<port>/auth/callback`: a BSD socket listener takes the code and answers with a 302 to
  `ardia-chatgpt://signed-in`, which closes the `ASWebAuthenticationSession` sheet (at most eight clients, ten seconds
  each). The ID token's RS256 signature is checked against the issuer's JWKS, failing closed, with its claims, and a
  later sign-in must return the same account. Tokens live in the Keychain (`com.ardia.browser.ios.chatgpt`, this
  device only, after first unlock); the hour-long access token refreshes two minutes early, one refresh at a time,
  and a rotated refresh token is saved before anything else. Answers stream from `POST /v1/responses` with exactly
  `model`, `instructions`, `input`, `store: false` and `stream: true`, and count only on `response.completed`. Any
  failure (limit reached, not eligible, network, a stream cut short, an empty answer) drops the partial text and
  Apple Intelligence (Gemini Nano on Android) writes the answer, with the reason in the note. A model that lists reasoning levels
  (`supported_reasoning_levels`) gets a Thinking picker, sent as `reasoning.effort`; Automatic sends nothing.
  Disconnect waits for a refresh in flight, then revokes the latest refresh token and says so when OpenAI doesn't
  confirm it. On Android the sign-in opens in a Custom Tab, or another browser when there is none (never Ardia itself
  while another browser exists), and `ChatGPTReturnActivity` takes `ardia-chatgpt://signed-in` back to the app;
  coming back with no code inside two seconds counts as cancelled. The connection is sealed with AES-GCM under an
  Android Keystore key (`KeystoreKeyStore`, alias `Ardia ChatGPT Key`, in `noBackupFilesDir`). Every ChatGPT request
  goes through an OkHttp client with no cookies, no cache and no redirects. Closing the page, or disconnecting while
  ChatGPT is writing, cancels the request at once; a disconnect mid-answer rewrites it on the phone.
- **In Settings.** Settings › Experimental lists Browse for Me. Its row reads "ChatGPT" when connected and "On
  iPhone" (iPhone) or "On This Phone" (Android) otherwise. On iPhone the page is the native `BrowseForMePage` and holds
  Talk to Me (below); on Android it is `components/settings/BrowseForMePage.tsx` on the hand-built settings
  kit, fed by the module's `account()`, `connect()`, `disconnect()`, `chooseModel()`, `chooseEffort()`,
  `clearProblem()` and `openUsage()`, and the `account` event carries the whole account state.
- **Testing.** On Android a lab build (`-PardiaLab=true`) takes `--es BrowseResearch <query>` to open the page at
  launch; the excerpt and fake-server switches are iPhone only. On iPhone these need a test build (`ArdiaTestBuild`): `-BrowseResearch <query>` opens the page at launch;
  `-ArdiaResearchWriter excerpts` skips the model; `-ArdiaChatGPTIssuer <url>` and `-ArdiaChatGPTAPI <url>` point
  ChatGPT at a fake server.
  `-ArdiaVoiceHeard <text>` opens voice search as if it had just heard those words, for a capture of its buttons.
  `-ArdiaSettingsPage browseForMe` opens the settings page. Talk to Me's switches are below.
- **Left for a person.** A real Plus or Pro sign-in.

### Talk to Me

Browse for Me's answers read aloud on iPhone (#2845), by Phonon 31M (Gradium, Apache-2.0, English only), on the
phone. The owner chose Phonon over Apple's voices and Kokoro, and the model must not grow the app's download.

- **Engine.** `ptts` 0.7.1 from `https://github.com/gradium-ai/xn-ptts.git` (module `PhononTTS`), pinned exactly in
  the `packages/phone/ios/ArdiaTalk` package's `Package.swift` and `Package.resolved`, wrapped by its `ArdiaTalk`
  target (`TalkSpeaker`), which the Podfile links into `ArdiaPhoneNative` beside ArdiaBrowser and ArdiaDesign. It is a
  package of its own, not part of ArdiaKit, so the app project, which loads ArdiaKit for its extensions, never resolves
  Phonon. `release-ios` archives with `ENABLE_SIGNATURE_AGGREGATION=NO`: otherwise both the
  package and `ArdiaPhoneNative` collect `PhononCore.xcframework-ios.signature`, and xcodebuild fails copying the second
  into the archive's Signatures folder. It has to be on the command line, since the package's own targets take no
  project settings. Phonon's is the only xcframework signature the app has. A local Xcode archive needs the same setting. Its compiled core is a static arm64
  library; it adds about 13 MB to the app binary uncompressed (13.3 MB against 0.05 MB for an empty iOS dylib,
  stripped, Release), about 4 MB compressed. `TalkSpeaker` keeps one `Phonon` and its own `AVAudioEngine`: a player
  node through `AVAudioUnitTimePitch`, whose `rate` is the speed (pitch kept). Voices are the `.safetensors` files in
  the models' `voices/` folder, switched with `Phonon.setVoice(_:)` (about 0.6 s, applied from the next sentence).
  Each answer block is one `tts.stream(_:)` call, consumed in order; `pause()` and `resume()` pause the player node,
  cancelling the consuming task stops generation, `stop()` clears what was scheduled, and when the engine stops on a
  route change it restarts at the block being heard.
- **Distribution: our own download from GitHub, on demand.** The voice is one LZFSE Apple Archive,
  `phonon-31m-en.aar` in the `phonon-31m-en-v0.7.1` release of `ardia-browser/ardia-voices` (132,936,282 bytes, SHA-256
  `f72408f2…6579`). It unpacks to `TalkToMe/`: the three Core ML models compiled to `.mlmodelc`, `host.safetensors`,
  `tokenizer.json`, a pruned `bundle.json` and six voices (Harper, Juniper, Miles and Preston, American; Maeve and
  Hugh, British), 156 MB installed. The models are compiled on the Mac, so the phone never compiles or writes beside
  them (`Phonon` compiles only a `.mlpackage` with no `.mlmodelc` beside it). The URL, size and SHA-256 are pinned
  together in `VoiceDownload` in `packages/phone/ios/VoiceDownload.swift`. Turning Talk to Me on downloads it with a
  foreground `URLSession` download task into `Application Support/TalkToMe-incoming-<uuid>/`, checks the byte count and
  the SHA-256 (CryptoKit, streamed in 4 MB reads), unpacks it with AppleArchive into the same folder, writes
  `voice.sha256` into the unpacked `TalkToMe/`, and moves it to `Application Support/TalkToMe` in one step (replacing
  an older one), excluded from backup; the archive and the incoming folder are then deleted. A wrong size or hash
  deletes the archive and fails. The voice counts as in only when that folder's `bundle.json` is there and its
  `voice.sha256` matches the pinned one, so pinning a new voice treats the old folder as absent and deletes it.
  Nothing downloads before the switch, and the app binary carries no part of the voice. No App ID, extension, App
  Store Connect upload or TestFlight is involved: development, ad hoc and simulator builds download it the same way.
  `apps/phone/ios/TalkToMe/build-voice` makes the archive: it fetches `phonon-31m-en-coreml.zip` from xn-ptts' v0.7.1
  release, checks its SHA-256, every kept file against the zip's `bundle.json` and each voice against `voices.tsv`,
  compiles with `coremlcompiler`, packs with `aa archive -d <stage> -subdir TalkToMe -o phonon-31m-en.aar -a lzfse`
  (reproducible: the same stage gives the same bytes) and prints its size and SHA-256. The model files are never
  committed.
- **Settings › Browse for Me › Talk to Me.** The switch (off by default) starts the download and shows its progress
  with Cancel, or the failure with Try Again ("Check your connection" for a network error, "Try again in a moment"
  for anything else, a wrong hash included); a failure stays until Try Again or the switch. With the voice in: Speed (0.8× to 1.5×), the six voices (a tap chooses one and plays a short sample), the
  download's size and Remove Voice Download (confirmed; it turns Talk to Me off). The footer says the bar at the end
  of an answer plays it, or the phone held to the ear does, that Phonon speaks it on this iPhone and nothing leaves it,
  and that it is English only for now. Settings are in `UserDefaults` (`ArdiaTalkToMeOn`, `ArdiaTalkToMeVoice`,
  `ArdiaTalkToMeSpeed`). Phonon is the only voice: no system voice is ever used.
- **Nothing reads on its own.** Reading starts only from the speaker button or from raising the phone to the ear.
- **The listen bar and hold to your ear** (the SwiftUI app's design from #1724, now with Phonon). While the answer
  page is open, Talk to Me is on and its voice is in, the proximity sensor is on (`ProximityFeed`). Once the answer is
  done and English (`NLLanguageRecognizer`; an answer under 40 letters counts as English when every letter is Latin), a glass bar sits at the bottom of the
  page: an ear, a line ("Hold your iPhone to your ear to listen", "Reading at your ear", "Reading out loud", "Paused.
  Hold it to your ear to keep listening", "Paused", "Hold it to your ear to hear it again"), the speaker button
  (Play Out Loud, then Pause) and a fill showing how far it has read. Raising the phone to the ear reads the answer
  through the earpiece; lowering it pauses, raising it again resumes, and after the end it starts over. Holding it up
  before the answer is done starts it when it is. The speaker button plays it out loud, and raising the phone moves
  that to the earpiece. The rules are `EarListening` in ArdiaKit's `ArdiaBrowser/Research` (tested). The text has
  `[n]` citations, markdown, link targets and list numbers removed (`SpokenAnswer`), one utterance per heading,
  bullet or paragraph, so a reroute or an engine restart picks up at the block being heard. The earpiece is
  `.playAndRecord` with `.spokenAudio` and no `.defaultToSpeaker` (the receiver), so iOS can ask for the microphone
  the first time (the usage string says why); out loud is `.playback` with `.spokenAudio`, ducking other audio, so it
  plays with the silent switch on. A call, Siri, unplugged headphones or the app leaving the foreground pause it; a
  new search, opening a source, Search the Web or closing the page stop it and turn the sensor off. In the simulator
  the page blacks out while "near", as a real screen turns off.
- **Testing** (test builds only). `-ArdiaTalkToMeModels <folder>` loads the models from a folder instead of the download
  (`build-voice --models-only --out <dir>` writes `<dir>/stage/TalkToMe`); the simulator can also download the real voice.
  `-ArdiaTalkToMeRecord <path.wav>` also writes what was generated to a 24 kHz WAV, finished when the answer ends or
  the page closes, with `<path.wav>.txt` listing each block (time, output, index, text). `-ArdiaProximity
  "4:near,12:far"` plays proximity changes at those seconds after the page opens, and `xcrun simctl --set <set> spawn
  <udid> notify_post com.ardia.browser.ios.proximity.near` (or `.far`) sends one by hand. `-ArdiaTalkToMeOn YES`
  turns Talk to Me on for the run (the setting's own key, through the launch argument domain). The app logs
  `TALKTOME first audio after … (earpiece|speaker|sample)`, `TALKTOME utterance: …`, `TALKTOME voice installed after …` and
  `TALKTOME download failed: …`.
- **Telemetry.** Five counts in `usage_counts`: `talk_to_me_answers_read` (an answer whose first audio played, once per
  answer, never a sample: the total), `talk_to_me_ear_listens` (those started by raising the phone to the ear), `talk_to_me_voice_downloads` (the voice downloaded, checked and unpacked), `talk_to_me_download_failed`
  (it failed, not cancelled: offline, a bad status, a wrong size or hash, or an archive that wouldn't unpack) and `talk_to_me_failed` (the models wouldn't load or speech failed). The native side sends
  `{ name: "talkToMe", count }` on `onBrowseForMe`, and `noteBrowseForMe` counts it outside Incognito.
- **Left for a person.** The download over a phone's cellular connection, the real proximity sensor and the
  earpiece route, the microphone prompt, the sound with the silent switch on, ducking under music, a call
  interrupting it, and the Neural Engine's speed.

## Pinch to Summarize

Pinch to Summarize is a standalone iPhone page action inspired by Arc Search. The card summarizes the open page
and appears over it. The phone reads the text from the live tab and processes it locally.

- **Off until turned on.** A switch in Settings › Experimental (the Pinch to Summarize page on Android) turns it on.
  It is off on fresh and older installs. The native layer keeps the switch (`PageSummarySwitch` in ArdiaKit's
  `ArdiaBrowser/Research`, `pageSummaries.enabled` in `UserDefaults`, `PageSummarySwitchTests`; Android's
  `PageSummaryChoice`, `enabled` in `ardia-page-summary`, `PageSummaryChoiceTest`) and gates both the pinch and
  `summarizePage` on it. While it is off the pinch watcher never starts, so it never measures the viewport or reads
  the page. Ordinary pinch zoom is unaffected. JavaScript reads it with `pageSummariesEnabled` into
  `state/pageSummary/enabled.ts` at startup and whenever Settings mounts. A failed read counts as off, and a read that
  started before a change never overwrites it. The page menu's Summarize Page row shows only while it is on.
  Turning it off resets every pinch watcher, closes any card and cancels a summary in flight. Each change moves a
  revision that a session and the Android watcher's delayed checks compare, so work from before an off and on again
  stays dead. The writer choice on Android is stored separately and survives the switch.

- **Where it starts.** Pinch in on a web page at its minimum zoom or choose Summarize Page under Find on Page.
  Both wait for the page to finish loading. WebKit handles ordinary page zoom alongside the summary's
  `PagePinchWatcher` in `packages/phone/ios/PageSummary.swift`. The decision is `PagePinch` in ArdiaKit's `ArdiaBrowser/Web`
  (`PagePinchTests`): it starts only when the scroll view's `zoomScale` sits at its `minimumZoomScale`, on a visible,
  loaded http(s) page, and fires only on a successful end, with the fingers at 0.7 of their start or closer, no outward
  move first, no reversal of more than 0.12 from the smallest scale, the zoom still at its minimum, and the same page
  and the same `WebTab.navigationGeneration` as at the start (a navigation, a same-document navigation, a reload or a
  discard in between cancels it). A cancelled or failed touch does nothing.
- **What it reads.** `WebTab.readableContent()`, the Reader's extraction, run on the live page. The prompt and the
  fallback are `PageSummaryDigest` in `ArdiaBrowser/Research` (`PageSummaryDigestTests`), which reuses Browse for Me's
  excerpt and sentence logic.
- **Who writes it.** Apple Intelligence on the phone (`SystemLanguageModel.default`) summarizes the extracted text
  and can retry with half the text budget. If it is unavailable or fails, the card explains why and shows up to
  four key lines from the page description and the opening sentences of its paragraphs. Android never shows key
  lines (below).
- **The card.** A compact glass card at the bottom of the page (`PageSummaryLayer`, hosted inside `PageView` above the
  WKWebView), clear of the bottom bar. The page around the card still accepts touch input.
  It closes with its × button, a swipe down on its header, VoiceOver's escape, a navigation, a tab switch, the deck, the
  page's discard or the view leaving its window, and a result that comes back after any of those is dropped
  (`PageSummarySession.isCurrent`).
- **Counting.** `page.summaryOpened` and `page.summarySettled` reach `state/page/actions.ts`. It counts them in
  `usage_counts` for regular tabs when anonymous usage sharing is on.

### On Android

The same action, card and menu row, with a choice of writer in Settings › Experimental › Pinch to Summarize.

- **Where it starts.** `PageView` watches touches without taking them (`dispatchTouchEvent`, before the WebView's own
  interception), so WebView keeps every ordinary pinch zoom. `PagePinchWatcher` follows the two fingers by pointer ID,
  drops the pinch on a third finger or a cancel, and asks once more `PagePinch.SETTLE_MILLIS` after the fingers lift; a
  new touch, a cancel, a navigation or the view leaving cancels that. The decision is `PagePinch` in
  `com.ardia.browsing` (`PagePinchTest`, `PagePinchWatcherTest`): the iPhone's span rules, plus a latched `WebView.scale`
  at the second finger that must still hold when the viewport is measured and at the end (a pinch the WebView zoomed
  never opens the card), and a viewport check (`visualViewport.width` against the root's `clientWidth`, which also
  holds for a desktop page shown in overview) at the start and the end. Text zoom (`pageZoom`) plays no part. The
  one-finger swipe that was waiting to claim a drag is dropped when a second finger lands (`PageGestures`).
- **The document.** `PageDocument` counts a new address, a same-document navigation, a load starting (a same-URL
  reload) and a new WebView (a discard or a renderer crash). A summary or a pinch from an older document is dropped.
- **What it reads and who writes it.** `Page.readableContent()`, the Reader's extraction on the live page, then
  `PageSummaryDigest` in `com.ardia.research` (`PageSummaryDigestTest`). `PageSummaryWriting` (`PageSummaryWritingTest`)
  picks the writer from the saved choice (`PageSummaryChoice`, `ardia-page-summary` preferences): On This Phone (the
  default) is Gemini Nano through `OnDeviceWriter`, halved once on failure; it never fails over to ChatGPT. ChatGPT
  sends the extracted text with `PageSummaryDigest`'s prompt through Browse for Me's `ChatGPTAccount`
  (`BrowseForMeHost.account`, the same connection, model and Thinking choice), straight to OpenAI. If it fails or
  answers nothing, Gemini Nano writes the summary and the note gives the reason; if the account isn't connected, that
  run stays on the phone with a reconnect note and the saved choice is kept. A disconnect while ChatGPT writes
  rewrites the summary on the phone. The choice applies to every page, Incognito included, as Browse for Me's
  connected account does.
- **No key lines.** Android never quotes the page. When no writer succeeds the card says so plainly and the outcome
  is `failed` (`PageSummaryWriting.Unwritten`): the reason from `OnDeviceWriter.Availability` (such as "Google lets
  apps use Gemini Nano only on newer phones, such as the Pixel 9 and Galaxy S25."), "Gemini Nano is still
  downloading. Try again when it's ready." or "Gemini Nano couldn't summarize this page." (or the AICore reason when the
  write was refused, such as "Gemini Nano is busy right now."), after ChatGPT's reason
  when ChatGPT was chosen.
- **The card.** A Compose card (`PageSummaryCard.kt`) in a `ComposeView` laid out inside `PageView` above the WebView,
  above the bottom bar's `toneInsets`. Touches on the card skip the page's swipes and the pinch watcher. It closes
  with its ×, a swipe down on its header, TalkBack's Close Summary action, a new document, the view being hidden or
  leaving its window, an unbind, and JavaScript's `dismissPageSummaries` on a tab switch, the deck or another surface.
- **Settings.** `components/settings/PageSummaryPage.tsx` (`state/pageSummary`), offered where the module has
  `setPageSummaryProvider`. The Settings row reads Off until the switch is on; the writer choice shows only while it
  is on. Choosing ChatGPT without an account signs in first and saves the choice only after it connects; nothing is
  summarized by the sign-in. On iPhone the switch is a row in Settings › Experimental (`ExpoSettingsRoot.tsx`).
- **Testing.** ChatGPT's endpoints are fixed on Android, so the ChatGPT path is covered by `PageSummaryWritingTest`'s
  injected writers, not a fake server.

## Telemetry

Off until the user chooses, in Settings (Share anonymous usage stats, with What's Sent) or on onboarding's last step. The consent model is the Mac's: nothing is sent, queued or counted while sharing is off, turning it off drops the queue, the day's counts and any request in flight at once, and an install ID is made only the first time sharing is turned on. Unlike the Mac, the phone sends no `daily_active` ping while sharing is off.

The gate is one file, `apps/phone/src/lib/telemetryGate.ts` (`createGate`): every capture, count and send goes through `isSharing()` there, and `state/telemetry/telemetry.ts` makes the app's one instance on the preferences table (`telemetry.sharing`, `telemetry.installId`, `telemetry.daily`, none of which the old iPhone app's import can set). The schema is `lib/telemetrySchema.ts`: every field is a fixed value, an enum, a bounded count or duration, or a version or UUID pattern, and a record that fails it is never queued. The OTLP encoding is shared with the Mac through `packages/core/src/telemetryWire.ts`.

Events (service `ardia-phone`, `$lib` `ardia-phone-telemetry`, tags `app: phone` and `platform: android|ios` on every one):

| Event | Fields | When |
| --- | --- | --- |
| `sharing_turned_on` | `source` (settings, onboarding) | turning sharing on |
| `app_launched` | `legacy_import` (imported, started_fresh, none), `legacy_import_failures` (failed tries before the app opened), `look_mode` (full, no_blur, no_motion, neither: the look this launch shows, after the look's budget and the system's Reduce Motion and Reduce Transparency), `interface_style` (match_mac, glass, classic) and `color_scheme` (match_mac, system, light, dark): the redesign's Appearance choices, and `material_colors` (wallpaper, profile, fallback, not_material): where Android's Material design took its colours, from the wallpaper, from a picked profile colour, or from Ardia's own palette on phones that give none; not_material on iPhone and in the original design, and `color_choice` (match_mac, preset, custom): the colour row's choice | each launch with sharing on |
| `perf_launch` | `launch_ms`, `js_ms` | each launch, once the module gives the process start (`ArdiaPhoneSystem.processStartedAt()`, epoch ms) |
| `perf_backdrop` | `backdrop_ms` | each launch on iPhone, once the native launch backdrop has shown (`system.launchBackdropShownAt()`, epoch ms on the process start's clock) |
| `perf_launch_tray` | `tray_ms` | each launch with Auto-Open Keyboard on, once the launch tray is up (process start on `ArdiaPhoneSystem.processStartedAt()`'s clock) |
| `usage_counts` | `tabs_opened`, `searches`, `pins_to_mac`, `tabs_sent`, `page_processes_gone`, `links_given_up` (a link whose handling passed its 8 s deadline), `pages_reloaded_online` (a failed page reloaded when the phone came back online), `find_opened_system` and `find_opened_bar` (Find on Page opened in WebKit's own panel, or in the app's find bar), `spaces_swiped` (a swipe in Spaces or on the start page that changed the profile), `tray_hidden_rows_opened` (a tray row opened while it peeked or sat under the keyboard), `deck_pictures_at_press` (a Tabs tap or bar swipe that had to copy the page at the press), `deck_opens_while_landing` (a card tapped while the deck was still landing), `deck_pictures_late` (a deck that took over while the leaving tab's card had a picture that hadn't painted; a tab with no picture isn't counted, and nothing waits for it), `search_tabs_opened` (the deck's Search Tabs field focused, in the redesign), `spaces_picked` (a space picked from the deck's switcher menu, or by a VoiceOver adjustment of the start page's dots, that changed the profile, in the redesign), `tabs_moved_to_space` (a tab moved to another space with the deck card menu's Move to Space, in the redesign), `pages_printed` (a page printed from the page menu's Print, counted when the print sheet opened, in the redesign), `pages_translated` (a page sent to Google Translate from the page menu's Translate, never from an Incognito tab), `pinned_tabs_refound` (a pinned site's tile or row switched to the tab it had opened after that tab had left the pinned address, where it used to open a second copy), `site_permissions_revoked` (a site's camera, microphone or location access revoked from Site Settings, by swipe or by its dialog, on iPhone's Expo UI Settings), `tray_back_swiped` (a search tray closed with Android's predictive back swipe), `card_opens_waited` (a card opened from the deck whose page didn't lay out within 250 ms, so the open was held until that cap), `native_menus_opened` (a menu opened as the system's own: a deck card's long press, the deck's ···, the space switchers, the + menus, Reader's Text Appearance, the page menu's Send to Device, the tabs button's recent tabs, on iPhone), `drawn_menus_opened` (a menu or confirmation card the app draws itself opened: every menu and confirmation card on Android, and on iPhone the few that have no system counterpart, such as a page link's long press; neither menu count is taken on the deck's Incognito side, on an Incognito page or for an Incognito card), `library_opened` (History, Bookmarks or Downloads opened from the page menu), `deck_grid_shown` (Grid picked for the deck in Settings › Appearance › Tabs, on iPhone), `landscape_shown` (a launch in which the phone was turned to landscape at least once, counted once a launch), `duo_layout_shown` (a launch on a Duo in any pose, or that used the wide or split layout at least once, counted once a launch, on iPhone), `list_sheets_late` (an Archive or History sheet whose rows were drawn more than 400 ms after it was asked for, on iPhone), `list_pages_added` (Archive or History adding its next 200 rows as you scroll, on iPhone), `search_reveals_late` (a search panel opened whose content had not laid out within 250 ms, so the stage revealed it on its deadline, on iPhone), `address_field_scrolled` (a long address in the search field scrolled sideways with a swipe, on iPhone), `deck_bar_swipes` (the deck opened by swiping up on the browsing bar, the second way in beside the tabs button), `tabs_swiped_closed` and `tabs_swiped_reopened` (a back swipe on a page with no history that closed its tab, and a forward swipe with no forward history that reopened the last closed tab), `page_menu_tapped_away` (the page menu closed by a tap on the page above it, on iPhone), `new_tab_search_opened` (search opened on a new tab in the iPhone's full-height search panel), `deck_incognito_switches` (a tap on the deck bar's Incognito switch that went from the normal tabs to the Incognito tabs, on iPhone), `deck_bar_swipes_returned` (a swipe up on the browsing bar let go before its commit point, so the page grew back), `tabs_bar_swiped` (a sideways swipe on the browsing bar that switched tabs), `tab_swipe_hints_shown` (the one-time hint for that swipe shown, on Android), `deck_pulls_hitched` (a swipe up or a tabs tap during whose shrink into the deck two UI-thread frames were more than 50 ms apart), `browse_for_me_opened` (Browse for Me opened from the tray, voice search or a launch argument), `browse_answers_chatgpt`, `browse_answers_on_device`, `browse_answers_excerpts` and `browse_answers_failed` (a Browse for Me answer by who wrote it, or a page that found or read nothing), `browse_chatgpt_fallbacks` (a ChatGPT answer that failed, so Apple Intelligence, Gemini Nano or the excerpts wrote it instead), `talk_to_me_answers_read`, `talk_to_me_ear_listens`, `talk_to_me_voice_downloads`, `talk_to_me_download_failed` and `talk_to_me_failed` (Talk to Me reading a Browse for Me answer aloud once per answer, and of those the ones started by raising the phone to the ear, its voice download finishing or failing, and its models or speech failing, on iPhone), `page_summaries_pinched` and `page_summaries_from_menu` (a page summary opened by pinching in or from the page menu's Summarize Page), `page_summaries_chatgpt`, `page_summaries_on_device`, `page_summaries_excerpts` and `page_summaries_failed` (a page summary by who wrote it, or a page it couldn't read or summarize; ChatGPT on Android only), `page_summaries_chatgpt_fallbacks` (a ChatGPT summary that failed, so Gemini Nano wrote it instead, on Android), `gemini_nano_downloading`, `gemini_nano_not_offered`, `gemini_nano_needs_update` and `gemini_nano_errors`, `gemini_nano_download_failed` and `gemini_nano_write_failed` (a Browse for Me answer or page summary that couldn't use Gemini Nano, by why: still downloading, not offered to apps on this phone, needing an AICore or system update, busy, out of space or failed to start, its download stopped, or it was available but couldn't write, on Android; the settled events carry it as `geminiNanoMissing`), `gemini_nano_download_rewrites` (a search answer rewritten with the Rewrite with Gemini Nano button after its download finished, on Android; the settled event carries `rewroteAfterGeminiNanoDownload`), `paste_and_go_links`, `paste_and_go_texts` and `paste_and_go_unread` (a Paste and Go tap with a link, with text, or that read nothing because the paste prompt was refused or the clipboard emptied; never counted while browsing privately), `search_tile_taps`, `voice_tile_taps` and `incognito_tile_taps` (Ardia opened from its Quick Settings tiles, on Android, counted on the phone and sent with the next day's counts), `start_logo_taps`, `find_closed_bar` (the app's find bar closed, once per find), `material_you_turned_on` and `material_you_turned_off` (Settings › General › Material You switched, on Android), `custom_theme_chosen` (Custom picked in Settings › Appearance when it wasn't the choice) and `theme_edits` (a change saved on the Theme page, one per release of a slider, the pad or the dial, or one per tap), and, with Material You on: `card_close_tapped` (a deck card closed with its ×), `material_back_swiped` (a back swipe out of a Material sheet, dialog or the library), `archive_bar_opened` (Archive opened from the bottom bar), `site_settings_sheet_opened` and `site_settings_sheet_expanded` (the address bar's page menu opened, and pulled to full screen; with Material You off, `site_settings_sheet_expanded` also counts Android's ··· page menu dragged from half height to full), `search_sheet_expanded` (the search sheet pulled to full screen) | at most once a day, for the last UTC day the app was used before today, when anything was counted; private tabs are never counted |

On the dashboard they are kept out of every Mac section by source and lib (`PHONE_APP_SOURCE` in `apps/dashboard/src/server/sql.ts`).

Lab and development builds follow the Mac's rule for its development builds: they send when sharing is on, marked so the dashboard can leave them out. A lab build sends `$environment: "test"` (a Metro development build `"dev"`) and the resource `deployment.environment: "development"`; only a store build sends `"production"`. So an upload from a tester's lab build (as from sync20c) is labelled, not mixed with users'. `usageToday()` in `state/telemetry/telemetry.ts` gives a lab today's counts and whether sharing is on, without sending anything. To check counts on a phone: lab › Telemetry shows sharing, today's counts, native's pending counts (read without taking them) and native's consent with its generation, refreshes on Refresh and on each return to the app, and logs each reading as `PAGELAB telemetry day … sharing … | counts … | native pending … | native consent …`.

Every count and timing the phone can send, for the owner to read as one set and strike what he doesn't want (the approved starting point was "the smallest set", c6ebf08a8). A new count needs a question someone would act on; those near the line say so.

| Count | Added in | What it answers on the dashboard |
| --- | --- | --- |
| `tabs_opened` | c6ebf08a8 | Is the phone used for browsing at all, per active day |
| `searches` | c6ebf08a8 | How much of that browsing starts from the tray |
| `pins_to_mac` | c6ebf08a8 | Whether pinning to the Mac is used enough to keep |
| `tabs_sent` | c6ebf08a8 | Whether Send to my Mac is used enough to keep |
| `page_processes_gone` | c6ebf08a8 | How often the page engine dies under people; a rise after a release is a regression |
| `launch_ms`, `js_ms` (`perf_launch`) | c6ebf08a8 | Cold launch time, process start to first screen, and the JavaScript share of it |
| `backdrop_ms` (`perf_backdrop`) | e9012f25a's native backdrop | Process start to the themed backdrop's first frame on iPhone; it should sit well under `launch_ms` (about 1,100 against 1,450 ms on the simulator), and rising toward it means the backdrop waits for JavaScript again |
| `tray_ms` (`perf_launch_tray`) | the launch tray at rest from its first frame | Process start to the launch tray being up. It should sit within a frame or two of `launch_ms`; a gap near 450 ms on Android means the launch tray waits for the keyboard again, and a blank start page catches taps behind an unseen tray |
| `legacy_import_failures` (`app_launched`) | 12a33bf03 | Whether the upgrade import fails in the field, and how many tries it takes |
| `look_mode` (`app_launched`) | 428c9a18d | How many phones the look's budget turns down, and to what; a share that grows after a release means the look got dearer |
| `links_given_up` | 16509434e | Whether a link's handling still hangs past 8 s; anything above zero is a bug to chase |
| `pages_reloaded_online` | b59e43a94 | Whether the reload on reconnect fires; near the line, worth striking once it is seen working |
| `find_opened_system`, `find_opened_bar` | Find on Page on WebKit's panel | How often Find on Page is used, and which find each phone gets: iPhone should count only system opens unless a tester switches the lab bar on |
| `spaces_swiped` | b9bb6e53e | Whether people find the swipe in Spaces or only use the switcher |
| `tray_hidden_rows_opened` | f5071fd5f | Whether rows past the keyboard are reached; near the line: zero would argue for a scrolling list, otherwise strike it |
| `native_menus_opened` | the menus sweep | Whether the system's own menus open where the drawn ones did; a drop against `tabs_opened` after a release means a native menu stopped opening |
| `drawn_menus_opened` | Android's drawn menus (the owner, 2026-11-19) | Whether people open menus on Android, where every menu and confirmation is drawn; split by `platform`. Read it against `tabs_opened`: a drop after a release means a drawn menu stopped opening |
| `library_opened` | the Library sheet on both phones | Watch History, Bookmarks and Downloads opens from the page menu by platform. A drop to zero can indicate the rows or sheet stopped opening |
| `deck_grid_shown` | the deck's grid on iPhone, picked in Settings › Appearance › Tabs since the owner's tabs pass | Whether people use main's grid view now that it lives in Settings; zero across testers after a release means the Tabs rows stopped switching |
| `deck_bar_swipes` | the owner's tabs pass (the swipe up on the bar, beside the tabs button) | Whether people use the swipe as well as the button; zero across testers after a release means the swipe stopped opening the deck |
| `deck_bar_swipes_returned` | the swipe that follows the finger (#2607; on Android too since the deck parity of 2026-11-19) | How often a swipe up is let go early. Read it against `deck_bar_swipes`: a share above about a third after a release means the commit point sits too far, or the swipe is caught by people who only meant to touch the bar |
| `tabs_bar_swiped` | the tab switching pass on Android (Discord, 2026-11-22: "switching tabs is still fucked, and there seems no easy gesture to switch tabs") | Whether people switch tabs with the bar swipe at all. Read it against `tabs_opened`: on Android it should rise after the release with the hint; zero across testers means the swipe stopped switching |
| `tab_swipe_hints_shown` | the same pass | How many phones saw the one-time hint (once per install, only when a page has a neighbour). Read `tabs_bar_swiped` per phone on the days after the hint's day: counts are daily, so on the hint's own day they can't tell whether the swipe came before or after it, and a phone with no swipes on later days only suggests the hint didn't teach |
| `deck_pulls_hitched` | the swipe that follows the finger (#2607; on Android too since the deck parity of 2026-11-19) | Whether the shrink into the deck drops frames in the field. Read it against `deck_bar_swipes` plus `deck_bar_swipes_returned`: it should stay near zero, and a share that grows after a release means something on the pull's path again blocks the UI thread. It sees only UI-thread gaps over 50 ms, not frames the GPU drops |
| `duo_layout_shown` | a launch on a Duo in any pose (the probe reports a hinge), or in `wide` or `split` | Whether anyone runs Ardia on a Duo or a full-screen iPad; zero after a release reaching Duo owners means the layout probe stopped reporting. Since #2840 it counts the closed and open Duo too, which now take `phone` |
| `landscape_shown` | landscape on both phones | How often people turn the phone; zero across testers after a release that rotates means the orientation lock came back |
| `card_opens_waited` | the card open's hand-over | Whether the page laid out within 250 ms of being made, from when the card's growth lands (it no longer waits for its cover's picture, and an open whose page lays out in time isn't counted); a share of card opens that grows after a release means pages are again slow to lay out and the open is held at full size |
| `deck_pictures_at_press` | a Tabs tap or bar swipe, as the pull starts (iPhone; an Android pull never copies) | Whether the page's picture had to be copied at the press because it wasn't current; that copy holds the first frame about 33 ms. The quiet-page copy keeps it current, so this should stay a small share of `deck_bar_swipes` plus Tabs taps, and a share that grows after a release means the quiet-page copy stopped running |
| `deck_opens_while_landing` | a card tap while the deck is still landing | How often people tap a card before the deck has settled; each one hurried the landing and opened the card as it landed. Zero over a release with many deck opens would mean the landing tap stopped reaching the deck |
| `deck_pictures_late` | the deck's hand-over, after the pull or the entrance shrink | Whether the leaving tab's card had a picture that hadn't painted when the deck took over (from 2026-11-22 nothing waits for it, so this counts cards that showed their face for a moment where they have a picture). A tab that has never had a picture always shows its face and isn't counted; a share that grows after a release means cards with pictures open on their face more often |
| `list_sheets_late` | the Archive and History opens on iPhone | Whether those sheets still mount their rows before they move; near zero is the goal, and a share that grows after a release means the open is again doing its work on the tap's path |
| `list_pages_added` | the Archive and History pages on iPhone | How often people scroll past the first 200 rows; near zero would argue for a larger first page or none, a large share for a smaller one |
| `search_reveals_late` | the search panel's open on iPhone | Whether the panel's field and rows lay out before the stage reveals them; zero across testers is good, and a share of `searches` that grows after a release means the panel's content mounts late |
| `address_field_scrolled` | the search field's swipe on iPhone | Whether people swipe a long address to read its end; zero across testers after a release means the swipe stopped scrolling the field |
| `tabs_swiped_closed`, `tabs_swiped_reopened` | the page's back and forward swipes past its history | How often the Arc Search edge gestures are used. A reopen share that jumps after a release is worth a look, since it can mean the back swipe now closes tabs people meant to keep; the counts alone don't say which closes were accidental. |
| `page_menu_tapped_away` | a tap on the page above the iPhone's page menu sheet | Whether people find the way out of the page menu after removal of the 90% cap. Its maximum height leaves 10 points between the sheet and the safe top; zero across iPhone testers after a release means the strip above the sheet stopped closing it |
| `new_tab_search_opened` | the iPhone's new-tab search panel opening (search not editing a page's address) | How often people start from a new tab's search; a sharp drop after a release means the panel stopped opening on a new tab |
| `deck_incognito_switches` | the deck bar's Incognito switch on iPhone (build 16 feedback) | Whether people switch the deck to Incognito from its bar; zero across testers after a release means the switch stopped showing or stopped switching. Taps back to the normal tabs are not counted, since they start in Incognito |
| `browse_for_me_opened` | Browse for Me on Expo | Whether people use Browse for Me at all; zero across testers after a release means the tray row or the voice button stopped opening it |
| `browse_answers_chatgpt`, `browse_answers_on_device`, `browse_answers_excerpts`, `browse_answers_failed` | Browse for Me on Expo | Who writes the answers: a share of `excerpts` that grows on phones with Apple Intelligence means the model path broke, and a growing `failed` share against `browse_for_me_opened` means search or page reading broke (DuckDuckGo's page changing is the likely cause) |
| `talk_to_me_answers_read`, `talk_to_me_ear_listens`, `talk_to_me_voice_downloads`, `talk_to_me_download_failed`, `talk_to_me_failed` | Talk to Me on iPhone (#2845) | Whether people listen: answers read against `browse_for_me_opened`, and how many of them start at the ear (`ear_listens`) rather than from the speaker button; zero ear listens across testers means the proximity sensor stopped starting it. `download_failed` against `voice_downloads` shows whether the GitHub download works; a rising `failed` against answers read means the models stopped loading or speaking |
| `page_summaries_pinched`, `page_summaries_from_menu` | Pinch to Summarize on iPhone and Android | It is off by default, so opens count only people who turned it on. A drop in pinch opens alongside steady menu opens can point to a gesture regression. A rise in pinch opens relative to `tabs_opened` can indicate accidental summaries |
| `page_summaries_on_device`, `page_summaries_excerpts`, `page_summaries_failed` | Pinch to Summarize on iPhone | A rising excerpt share can point to problems with Apple Intelligence. A rising failure share can point to problems reading pages |
| `page_summaries_chatgpt`, `page_summaries_chatgpt_fallbacks` | Pinch to Summarize on Android | Android has no excerpts, so `page_summaries_failed` against `page_summaries_on_device` is the share of phones without a ready Gemini Nano. How many summaries the opt-in ChatGPT choice writes; fallbacks rising against `page_summaries_chatgpt` mean the Responses call or the token refresh broke. On Android, pinch opens against menu opens show the passive pinch watcher working, and zero pinch opens after a release with steady menu opens mean it stopped |
| `gemini_nano_downloading`, `gemini_nano_not_offered`, `gemini_nano_needs_update`, `gemini_nano_errors`, `gemini_nano_download_failed`, `gemini_nano_write_failed`, `gemini_nano_download_rewrites` | Gemini Nano on Android | Why Browse for Me and Pinch to Summarize fell back. `not_offered` is the share of Android users on phones Google keeps the Prompt API from; `needs_update` or `errors` rising after a release or an AICore update means the ML Kit version and AICore disagree, so bump `genai-prompt`. `write_failed` against `browse_answers_on_device` plus `page_summaries_on_device` is the share of supported phones where Nano started but couldn't write: rising means the prompt or `fit` broke. `download_failed` is downloads AICore stopped, and `download_rewrites` against `downloading` shows whether people come back for the Nano answer |
| `start_no_tabs_button_taps` | Start's Archive or Synced Tabs button, which takes the place of Tabs when no tabs are open (#3324) | Whether people use it instead of landing on an empty tab view; zero across testers after a release means the swap stopped or the button stopped opening the Archive or the spaces |
| `tray_incognito_switches` | the search panel's Incognito eyes turning Incognito on (Redesigned look) | On Android, real finger presses on the eyes and on the panel's rows did nothing in 1.0.2: the panel's keyboard lift reached the view but not Fabric, so `Pressable` cancelled on the first MOVE. Near zero on Android beside iPhone's after a release means presses in the panel died again |
| `incognito_unavailable` | Incognito refused because this phone's Android System WebView can't keep private pages separate (no multi-profile support), shown as a toast that opens the WebView's store page, or an Incognito page that failed to open and was closed | Before, every Incognito page on such a WebView stayed blank and took no taps, with no message. Anything above zero means people on old WebViews meet Incognito; it should stay at zero on iPhone |
| `page_pictures_blank`, `page_pictures_hidden` | A tab switcher picture the iPhone threw away instead of saving: it came out one flat colour (`blank`), or the page was hidden or off screen when it was taken (`hidden`) | `blank` is how often a device still makes the empty card from the hltv report; the card keeps its last picture each time. A sudden rise in `hidden` means captures are being asked for pages that aren't showing |
| `page_pictures_webkit` | An iPhone tab switcher picture that came from the page engine's snapshot because the instant screen copy failed or came out one flat colour | Should stay near zero: the screen copy is the normal route. A rise means the copy stopped working on some iOS version and pictures depend on the late, sometimes blank engine snapshot again |
| `page_pictures_scrolled` | An Android tab's picture taken again because its page's scroll settled somewhere new while the page was still loading (#3496). Captures used to wait for a finished load, so a page that kept loading (The Verge, with its ads) kept a picture from before the scroll, and the first bar swipe after a launch showed that old picture, then the restored page somewhere else | It should be above zero on Android from the release on, a small share of `tabs_bar_swiped`. Zero across Android testers means the scroll watch stopped retaking pictures; a figure many times `tabs_opened` means a page reports loading for ever and the watch retakes it at every scroll |
| `paste_and_go_links`, `paste_and_go_texts`, `paste_and_go_unread` | Paste and Go, now on iPhone too | iPhone taps should appear beside Android's. A high unread share on iPhone means people refuse the paste prompt, or the row shows when nothing can be pasted |
| `search_tile_taps`, `voice_tile_taps`, `incognito_tile_taps` | Android's Quick Settings tiles | Voice and Incognito should appear once the release is out; a tile that stays at zero while Search counts can point to a broken tile |
| `browse_chatgpt_fallbacks` | Browse for Me on Expo | How often a connected ChatGPT plan fails to answer; a jump after a release, or against `browse_answers_chatgpt`, means the Responses call or the token refresh broke |
| `custom_theme_chosen`, `theme_edits`, `app_launched.color_choice` | the custom profile theme on the phone (2026-11-22) | How many testers make a theme of their own and how many keep it. `color_choice` = custom gives the share of launches on a custom theme. `theme_edits` against `custom_theme_chosen` shows whether people shape the theme or leave the starting one. Edits with no custom launches afterwards mean the theme doesn't stick: it fails to save, or people go back to a preset |
| `material_you_turned_on`, `material_you_turned_off` | the Material You switch in Android Settings (the owner, 2026-11-20) | How many testers try Material You and how many go back. Read `off` against `on`: a share near one means it is tried and dropped. `app_launched.material_colors` says how many launches run with it on |
| `card_close_tapped` | the × on a card in Android's Material deck | Whether people close tabs with the card's own button rather than a flick; zero across Android testers after a release means the × stopped closing cards, or its tap zone opens the card instead |
| `material_back_swiped` | a predictive back swipe on Android's Material sheets, dialogs, menus and library | Whether people swipe back out of Material surfaces; zero across Android testers after a release means the swipe stopped reaching them, or Back goes to the wrong surface |
| `night_shade_verdicts_reused`, `night_shade_verdicts_learned`, `night_shade_verdicts_corrected` | Night Shade's cached verdicts on Android (a tester's report: yahoo.com loaded white until half way) | Counted natively and drained with the pending counts, never for private tabs. `reused` is a page load, with Night Shade not off, whose site's verdict was already known, so the shade was decided before the first paint; `learned` is a site measured for the first time, whose first load can still shade late; `corrected` is a site whose verdict changed, so that load showed the old one until `DOMContentLoaded`. Read `reused` against `learned` for the hit rate, which should climb as testers revisit sites; a `corrected` share that grows means the measurement disagrees with itself between loads |

## What is left before the Expo app replaces both native apps

The bar is the Compose app on Android and the SwiftUI app on iPhone, screen by screen and setting by setting:
what each tap does, what is remembered, animations and their timing. Every item is one line: what it is, where it
lives in the native app, and its size (small: an hour or two; a day; more). Anything not yet seen working on a
phone is listed as unverified, even where the code is in. Audited 2026-11-15 at e1a9a4a7a.

Nothing is left in JavaScript against the old references. Android's largest items left are Send to Your Mac in
the share sheet and the tray's predictive back. The owner's open choices are in "Waiting on the owner"; what
nobody has seen working on a phone is the tester checklist below.
iPhone follows the SwiftUI app on main since the merge of main (8203d0b3c, 2026-11-15), and main's redesign of that app (a2cf29dac, d199b885c) moved the reference: what iPhone needs now is "The iPhone redesign" below. The audit above predates it.

### Decided by the owner (2026-11-19): Android takes the iPhone's design, with drawn menus

- On 2026-11-17 the owner rejected the redesigned Android build on the POCO F4: "hate it … the … dropdowns are weird everywhere" (#2496). The dropdowns were Android's own PopupMenu and AlertDialog behind `MenuTrigger` and `confirmInSheet`, which look nothing like the iPhone's menus.
- On 2026-11-19 he decided Android takes the iPhone's design after all, with the menus drawn by the app instead of the system's. Android's native menus module is gone, so every menu, picker and confirmation on Android is the drawn menu (`components/ui/Menu.tsx`) or the drawn action sheet (`components/ui/ActionSheet.tsx`), made to look and move like the iPhone's UIKit menu and action sheet. Their numbers sit in `menuLook`, `menuInk`, `actionSheetLook` and `actionSheetInk` (`components/ui/tokens.ts`), `menuMotion` (`components/ui/motion.ts`) and `lib/menuPlace.ts`.
- The measurements are the iPhone's on iOS 27 (`/tmp/ardia-menus/ios/SPEC.md`, 2026-11-19): a 250 pt panel with 30.5 pt corners, 42 pt rows, labels at 29 pt (43.7 with a checkmark column, 65 beside a leading icon), group dividers as 20.67 pt bands with a line inset 24 pt, a pill press highlight inset 10 pt, no lines between rows. A tap menu sits on its trigger's matching corner and covers it (opening upward with its bottom on the trigger's when there is no room below), grows out of that corner on a 0.3 s spring and shrinks back into it in 200 ms. UIKit's spring overshoots about 2.5 %; since 2026-11-20 the drawn menu's spring is critically damped on both phones, because menus are used all day and the owner's motion rule allows no overshoot there. A long-press menu dims the screen (black 20 % light, 48 % dark). A confirmation is iOS 27's centred card: title, message, one pill button and no Cancel row, shown at once and fading out in 270 ms with nothing dimmed. Deliberately different: a long-press menu opens at the finger (the owner's rule) where UIKit places it from the lifted view and lifts that view; and a tap outside a confirmation only cancels it, where iOS also lets the tap through to what is underneath. Back cancels it, and TalkBack reaches the outside area as Cancel.
- Android keeps its touch habits: a long press opens the menu at the finger with the screen dimmed behind it, a tap outside or Back closes it (Back on a submenu goes back to its menu), the menu never runs off the screen or under the system bars, TalkBack moves into the menu and back to its trigger on close, and the app behind it is hidden from TalkBack while it is open.
- Material You for Android (#2537, draft #2557) is dropped. The redesign switch from #2477 is on main: `designFor("android")` answers redesigned, and the deck's grid is offered on both phones.
- `drawn_menus_opened` counts each drawn menu and confirmation card opened, by platform, never while browsing privately.
- After the F4 and M3 pass on 6f1b5eae1: nothing sharp shows through a menu or confirmation. Menus frost what they float over where a frost source covers it (the deck, the start page), drawing their fill as a layer over the native frost, which paints over a view's own background; over a page, in sheets and in the tray, where nothing can be frosted, they are opaque #F8F6F7 / #504C4D, sampled to match iPhone's menus over the app. The confirmation card is opaque #F9F9F9 / #777777, as iPhone's reads. An overlay layer is kept until its close has played (the menu shrinking into its trigger in 200 ms, a long-press menu and its dim in 270 ms, the confirmation fading in 270 ms), and a new layer drops a closing one at once, so a confirmation opened from a menu row shows alone. A tap menu's corner sits exactly on its trigger's even inside the screen margin, a Settings picker lines its trailing edge up with the row's value, and a long-press menu with no room below ends 16 pt above the finger. RN 0.88 gives a row with `accessibilityRole="menuitem"` TalkBack's "menu item" role description (`ReactAccessibilityDelegate.setRole`); uiautomator's dump does not list role descriptions. Translate with Google stays the drawn centred dialog: iPhone shows the same component there. After the second pass (4d3e2f246): every menu that can sit over a page, the Reader or the Duo page is opaque, and `src/dev/menuSites.test.ts` lists every menu site with what it floats over, so a new one has to choose. A tap menu closes as iPhone's does: its rows fade within about five frames while the glass shrinks into the trigger's own size, from the trigger's corner, over 200 ms. A long-press menu that can't fit below ends 16 pt above the finger or above the pressed control when that is small (64 pt or less, like the tabs button), and the deck's menus stay above its bottom bar. On Android, RN's `setAccessibilityFocus` only sends a view-focused event, which doesn't move TalkBack, so after the third pass (dd6b6e5e9) focus goes through the module's own `focusView` (`AccessibilityModule.kt`: the view found by its React tag, then `ACTION_ACCESSIBILITY_FOCUS` once it is attached, laid out, visible and not under a view hiding its descendants, retried on the main thread for up to half a second; each request has an id the JS cancel revokes with `cancelFocus`, and the module drops every pending request when it is destroyed), a quarter second after the overlay lays out: onto a menu's first row, back onto the trigger when a menu closes without a choice, and onto a confirmation's heading. A long press with no touch point, as TalkBack and Switch Access send, places its menu from the pressed control. A tap menu's glass shrinks linearly into its trigger and is gone at 200 ms, its fade folded into the shrink's last frames. On Android, as with PopupMenu, Back dismisses a menu, so the menu's scrim takes no TalkBack focus (TalkBack once moved onto it after the first row); the confirmation's outside area does the same, and its buttons carry a Cancel action instead. A deck card, stack or grid, has a Tab Options action on Android that opens its menu from the card (the stack's menu follows the tab, not its place, so a tab closing meanwhile never moves it to the next one), and a Settings picker gives focus back to its row after a choice. Every focus request can be cancelled and checks again just before it lands, so the trigger's restore is dropped when the menu reopens, the trigger is turned off or goes away, or any newer overlay has opened, even one that has closed again; a restore already handed to the native side is revoked the moment that overlay opens. The native requests stop for good when the module is destroyed, its teardown run on the main thread. `src/dev/menuSites.test.ts` counts menu sites per file, every use of a registered menu opener (`components/ui/menuOpeners.ts`, confirmations included), each with its material.
- After the fifth phone pass (669e6dcc5): focus goes back to a trigger only once the overlay has uncovered the app, that is once the closing layer is removed and the app is readable again, plus a frame; the restore timed from the close let TalkBack land on `···` and then slip to the Space name a quarter second later. A layer goes when its own close animation reports it has finished, with a fallback 150 ms after its exit time. A tap menu's rows fade in four frames (67 ms) and its glass only in the last three (50 ms) of the 200 ms shrink, so the glass reaches the button's size before it fades. A confirmation gives TalkBack focus to its heading, one node reading title and message as AlertDialog's does, with no separate announcement, and Cancel is an action on the heading and on each button. A confirmation opened from a menu row hands focus back to that menu's trigger when it is cancelled (Back, a tap outside, the Cancel action), not when it is confirmed. A grid card's Tab Options gives focus back to the card itself, not to its menu's wrapper.
- After CodeRabbit's review of #2744: a suggestion's long-press menu in the search tray stays above the keyboard (its floor is the keyboard's top, from `keyboardTopFromBottom`, measured against the window, which the keyboard doesn't shrink on either phone). A card's menu whose tab goes while it is open closes and lets the deck go, so it is no longer shaded or hidden from TalkBack; a reorder keeps it. A confirmation opened straight from a Settings button (Clear Data, Restore Defaults, Remove This List, Stop Syncing) gives focus back to that button when cancelled, as one opened from a menu row does to the menu's trigger. Submenus nest: each opens over its parent and Back goes up one level at a time before the menu closes.
- After the sixth phone pass (f14475ee7): TalkBack sometimes took focus off a restored trigger about a frame after it landed and put it on the first header item. The app is already readable again the moment a layer starts closing (a closing layer counts as uncovered and hides itself), so TalkBack's own settling falls inside the close. A focus request retries natively until it lands (up to half a second, giving up before an attempt past that deadline), and a view that already holds TalkBack's focus counts as landed. A restore (to a menu's trigger, a deck card or a Settings button) goes through the module's `returnFocus`: every attempt, the first, each retry and one more 300 ms after it lands, focuses the target only while TalkBack's focus is free: on no view, on the window's first stop (the topmost visible view on screen with a label or a click action, the leftmost of those, or the rightmost in a right-to-left layout, where TalkBack's reset lands; on the deck that is Space, Personal, although the cards come first in the view tree), on a view inside a hidden or closing layer, or on the target already, which counts as landed. If any other visible node holds focus, including a link or text a page holds as a virtual node of its WebView's node provider, the user (or TalkBack restoring focus elsewhere) has moved on, and the request ends without focusing and without a second ask. Nothing is asked again if the first ask never landed. Phone pass 8 saw an unnarrowed second ask pull a user's move to Incognito back to `···` 6 times in 6; pass 9 saw the first ask itself do it 3 times in 7 when the user moved before or just after it landed, and a reset to Space, Personal left alone once because the first stop was then found in tree order (a deck card); the JS cancel drops that second ask too, so a reopen, a newer overlay or the opener going stop it. Phone pass 7 (ffff9e6fd) settled this: in 8 of 23 restores TalkBack itself moved focus to the first header item for one or two frames after the first ask, and the second ask brought it back every time, while a user swiping away within 300 ms of a restore is rare. Focus into a menu's first row or a confirmation's heading is asked for once, with no second ask. A tap menu's glass fades only in the last two frames (33 ms) of its 200 ms shrink.
- A stack card's Tab Options menu used to drop the card once it was measured, so the app asked for no focus after Back; the return to the card phone pass 5 saw came from TalkBack itself. The deck now keeps the card as the menu's opener and, after a close without a choice, gives focus back to it once the menu has gone, by the same path as every other restore (`useFocusReturn`), only while that card's tab is still in the deck and dropped by a reopen or a newer overlay. Each Tab Options request owns the menu only until a newer one is asked for, so a slow measurement can't replace a later card's menu, and a request from before the deck went away opens nothing when it comes back.
- The dark confirmation keeps iPhone's title and message colours (#FFFFFF, #C8C8C8; sampled as #FFFFFF and #C5C5C5) on a darker card (#484848, iPhone #797979) and pill (#555555, iPhone #959595), with a lighter red label (#FFB8B9, iPhone #FF9B9C), so the message reads at 5.5:1 and the 17-point label at 4.5:1; iPhone's own are 2.5:1 and 1.5:1. The light confirmation stays iPhone's, whose message is 2.7:1 on its card.
- Confirmations follow iPhone: where iPhone asks with SwiftUI's confirmation (Clear Browsing Data, Restore Default Filter Lists, Remove This List, Stop Syncing This Device) or UIKit's action sheet (Close All Tabs, Close Incognito Tabs, Delete All archived tabs), Android shows the drawn confirmation card; Translate with Google stays the drawn centred dialog with Cancel on both phones. A menu taller than the screen is cut to the safe area and scrolls, and it is measured while hidden, so it first shows where its rows fit and keeps to its side of the finger when a submenu's page is taller. A turn of the phone closes an open menu as UIKit's does (the keyboard does not). A chosen row runs at once, once, while the menu plays its close; TalkBack goes back to the control that opened the menu only when it closes without a choice. A page link's long press opens at the finger like every other long-press menu.
- Later on 2026-11-19 the owner asked for Android's own character instead of iPhone's glass ("we don't really want it to look like Apple Glass … have a solid background"). Android keeps the drawn menus' structure (placement on the trigger or at the finger, Back, tap outside, TalkBack, submenus as pages) and draws them as Material 3; iPhone's drawn menus and action sheet are unchanged. The Android values sit beside iPhone's in `menuLook`, `menuInk` (picked by platform), `materialDialogLook`, `materialDialogInk` and `materialMenuMotion`:
  - a menu is a solid surface (#F3EDF0 light; dark #1E1B1D with a 0.5 dp white 12 % edge, since a shadow doesn't show on the dark deck) with 16 dp corners and level-2 elevation, no frost or dim; 48 dp rows with one-line 16 sp labels at 16 dp, or at 52 dp beside a 24 dp icon slot; icons show only when every row has one (the owner, 2026-11-19: a lone icon, as on a card's Send to MacBook Pro, misaligns the menu), and a submenu page keeps the slot for its Back chevron; icons in on-surface-variant, a full-width ripple, groups split by an 8 dp gap with no line (the owner, 2026-11-19: the horizontal rules between groups read as clutter; headings and the order of actions stay), the check at the trailing edge, and M3 error red (#BA1A1A, #FFB4AB) for destructive rows;
  - it fades in and grows from 80 % over 250 ms (emphasized decelerate) from its trigger's corner, and fades out in 150 ms (emphasized accelerate) without shrinking. Replaced on 2026-11-20 by the iPhone's motion (below);
  - a confirmation is an M3 basic dialog: 24 dp from the screen edges up to 560 dp wide, 28 dp corners, 24 dp padding, a 24 sp title and 14 sp message, Cancel (on-surface-variant) and the action (Ardia's plum primary, or the error red when destructive) as right-aligned text buttons, over a 32 % black scrim; it fades and grows from 92 % in 250 ms and fades out in 150 ms (replaced on 2026-11-20 by the iPhone's: shown at once, fading out in 270 ms). Cancel is neutral because the dark theme's primary and error are both pale pinks.
  - Android's dark mode uses one near-black, #1E1B1D, for the chrome (the bars, Search Tabs and the round buttons, `chromeInk.dark.surface`, #000000 before), the menus and the dialogs, so nothing reads as a blacker black than its neighbour (the owner, 2026-11-19). iPhone's chrome stays #000000 where it isn't native glass.
  - Material You colours (the wallpaper palette and a Dynamic Colors switch, #2692 and Sai Charan's #2693) are a separate PR; these neutral surfaces are the fallback they would tint.
- The rest of iPhone's deck and page parity comes to Android in the same PR (the owner, 2026-11-19: everything left except Material You):
  - the swipe up on the bottom bar carries the live page into its card and a card grows back into the page, on iPhone's thresholds and springs ("The swipe into the deck" under Deck speed); the tab view opens with the current card centred;
  - the Archive capsule comes back on every deck open until it is dismissed or an interval is picked, as on iPhone, where Compose marked it shown when it first offered it;
  - a swipe between tabs shows the space's own surface behind the pages (`PagerBackdrop`), where Android drew black. The dim over the leaving page stays black on both phones, and a history swipe inside a page already takes the profile's surface (`surfaceColor` on the page view);
  - a top pull on a page still refreshes it; nothing native changed.

### Android moves like the iPhone (the owner, 2026-11-20)

After the bottom bar's fold (4a844bcfb), the owner asked on the F4 for Android's animations to be the iPhone's
everywhere. Every motion value that was picked by platform now takes the iPhone's on both phones, and
`src/render/motionPerPlatform.render.test.tsx` pins them on both presets:

- the deck (`tabsMotion`): a card grows on the 0.18 s spring (Compose's 0.3), a released card settles on 0.26 s
  (0.3 at 0.9 damping), the deck scrolls to rest on 0.28 s (0.4), a gap closes on 0.22 s (0.4 at 0.8), the pager
  settles on 0.26 s (0.38), and the deck opens on SwiftUI's 190 ms arrive curve for scale and position together
  (Compose's 0.19 s and 0.3 s springs). Fades are 150 ms (200), a fly-away 160 ms (200), the bar's tone 200 ms (250),
  surfaces 150 ms (200);
- the search tray (`trayMotion`): it rises on SwiftUI's 360 ms rise curve (a 0.39 s spring), lands after 220 ms
  without a keyboard report (450), settles on 0.26 s (0.34 at 0.86), is dismissed on 0.14 s (0.32), a row press is
  0.16 s (0.2 at 0.7), the Incognito toggle 0.2 s (0.3 at 0.85), the dim 200 ms ease-out (300 ease-in-out) and the
  results 100 ms (140);
- the progress bar fills in 150 ms (200), fades in 200 ms (250), advances in 300 ms (450) and shows after 100 ms (150);
  a loading page's placeholder waits 250 ms and fades in over 150 ms (300 and 220);
- onboarding: a step slides 72 points on 300 ms of (0.05, 0.7, 0.1, 1) (60 dp on a 0.42 s spring at 0.9), the
  welcome rises on 360 ms after 50 ms (a 0.7 s spring at 0.7 after 100 ms), and Reduce Motion fades in 150 ms (200);
- drawn menus grow from their trigger's corner and shrink back into it as the iPhone's do (Material's 250 ms grow
  from 80 % and 150 ms fade are gone), on a 0.3 s spring that is now critically damped on both phones; a
  confirmation shows at once and fades out in 270 ms (Material's 250 ms grow from 92 % and 150 ms fade). The
  Material look, colours and layout stay;
- the swipe into the deck lands and returns on the iPhone's springs (a fixed 300 ms before);
- the voice screen's waveform bars ease to each new height over 100 ms, as on iPhone (Android jumped);
- natively (`PageGestures.kt`, `PageSettle`): a history swipe settles on a critically damped curve that lands in about
  220 ms, as UIKit's 0.22 s spring does (an ease-in-out 220 ms timing before), and pull to refresh settles on a
  critically damped 0.3 s spring (Compose's 0.3 s at 0.86, which overshot).

Kept per platform on purpose: Remove animations snaps on Android (`reducedMotionMs`); Android opens a card in the
column layout through the deck card in Reanimated (`cardOpen`), because iPhone's opening card is a Core Animation
growth and the Android equivalent (`coveringCard`) is still behind the `ArdiaOpeningCard` lab flag, while both phones
open through the pulled card in the redesign; and the host pill stays mounted with its glass shown at once on Android,
which the bar's fold needs. No new telemetry: `deck_pulls_hitched` keeps watching the swipe into the deck, and
`card_opens_waited` the card opens.

### Material You, a switch in Android Settings (the owner, 2026-11-20)

Settings › General › Material You turns the whole Android app to the Material You design and back. It is off by
default, so Android keeps main's iPhone design with drawn menus. It takes effect at once, with no relaunch: `useDesign()`
reads the `settings.materialYou` preference (`designFor(os, lab, materialYou)` in `lib/design.ts`), and
`followDesign` in `components/ui/design.tsx` re-applies the Spaces and Appearance design and starts following the
wallpaper palette when it turns on. iPhone never offers it. The design itself is our Material You branch of 17 to 18 Nov
(#2537, #2557) with Sai Charan's work from #2798 on top: the persistent bottom bar, the seamless search sheet,
Material Symbols, the pitch-black Incognito and the Settings layout.

What the switch changes, and what it leaves alone:

- Menus and confirmations stay main's drawn ones in both designs, already Android's Material 3 look since 2026-11-19.
  The branch's native Material menus (`MenusModule`, `MaterialMenus.kt`) and their `native_menu_actions` count are not
  carried over: the owner turned down the native dropdowns on 2026-11-17, and main removed the module.
- Material Symbols replace Ardia's drawn symbols only while the switch is on (`Symbol` and `MaterialSymbol`); Ardia's
  eyes, closed eyes and Browse for Me glyph stay its own. The Compose screens (Settings UI, the share sheet, summary cards)
  keep main's `ArdiaSymbols`, and the app's window colours stay main's, so the launch backdrop is the same with the switch
  on or off.
- The deck keeps main's pull and standby pipeline with the switch on; the branch's deferred entrance picture and its
  cross-fading card pictures are not carried over, since main's deck parity replaced that path.
- Main's tests run on main's design; the Material tests turn the switch on with `withMaterialYou()` from the render
  harness.
- My Filters puts the keyboard away when it is left by its back arrow or unmounted, with Material You on only;
  main's design is left as it is.
- Spaces split the tabs with Material You on exactly as they do in main's design (`tabSpacesFor` answers for every
  design but the original), so the Material deck's Space switcher shows that Space's tabs.

With the switch on:

- Settings › General › Dynamic Colors switches between the wallpaper palette and a custom color (2026-11-18). Turning it off shows the existing color picker; turning it on keeps the custom color saved. The choice is stored in `settings.dynamicColors`, applies immediately to the app, its menus and Incognito, and survives relaunches. Phones without a wallpaper palette use Ardia's fallback when enabled. Existing installs retain their current theme until the switch changes. Watch the existing `app_launched.material_colors` values for adoption; no new telemetry fields.
- Incognito start, search sheet and tab switcher use pitch-black backgrounds with the selected palette’s dark controls in both light and dark appearance (2026-11-18). They no longer invert the current scheme, which made dark-mode Incognito white. The page address field, native search capsule and tab-switcher search field also use black backgrounds with light text and icons. Incognito activity stays uncounted.
- The Material bottom bar is one 64 dp capsule, inset 16 dp from the sides and 8 dp above the navigation inset. The page extends behind it, with no full-width background band; touches outside the capsule reach the page. Scrolling down a page slides the capsule out below the bottom edge and scrolling up brings it back; Settings › Site Settings › Collapse Bottom Bar defaults on in Android’s Material design and keeps an explicit off choice. Tabs is on the left, search/address in the center, and add on the right. Hold Tabs for recent tabs, or hold the address for the page menu. In the tab switcher, the same capsule has Archive Tabs on the left, Search Tabs in the center and add on the right. Its 48 dp targets stay above the keyboard while filtering tabs. `Surfaces` mounts one `MaterialBottomBar` above the page and tab switcher. `isTabOverview` switches its controls without replacing the capsule. The page and deck controllers register their actions, page collapse, gestures and keyboard lift with the scoped `MaterialBarProvider`; neither screen nor its transition ghost mounts another bar. Search, fullscreen and overlays disable or hide this same instance. Watch `archive_bar_opened` (the Archive button, never while browsing privately) beside `search_tabs_opened` and `tabs_opened`, and `card_close_tapped` for the × on a deck card.
- Android's More options and search results use the same Material sheet and docked URL capsule. The docked bar supplies the fill and corners in both modes, including while the URL is editable. Tapping the URL in More options keeps the sheet and bar mounted, switches the body to search suggestions, and moves the bar as the keyboard opens. The existing URL or search query is selected for editing. Direct search uses the same sheet and moves the capsule up from the bottom bar. The Compose field keeps inline completion, clear, voice and Incognito controls inside the capsule. The sheet stays raised when the keyboard closes or becomes shorter, giving results more space. Turning the device resets the retained keyboard height when the width changes. Swipe up to expand the results, down to return to compact height, and down again to dismiss. Results can scroll independently after expansion. Remove animations skips the transition. Watch `search_sheet_expanded` against `searches`, and `site_settings_sheet_expanded` against `site_settings_sheet_opened` for the address bar menu pulled to full screen; none counts Incognito.
- Android Material Find dismissal uses the sheet's predictive Back handler and ends Find when the keyboard hides, restoring the bottom bar in the same transition. Material sheet rows and bar buttons use Gesture Handler Pressable because the synchronous Reanimated props path moves native views without updating Fabric hit testing. Watch `find_closed_bar` against `find_opened_bar` (counted in both designs, once per non-private find), and `material_back_swiped` for back swipes out of Material sheets, dialogs and the library.

Watch `material_you_turned_on` and `material_you_turned_off` in `usage_counts` for how many testers try it and how many
go back, and `app_launched.material_colors` (`not_material` while it is off) for how many keep it on.

### Android motion and menu follow-up

Settings keeps the same sheet and scroll view when Material You changes. The covered browser follows at lower
render priority, and open menus keep their opening design through dismissal. Watch the existing
`material_you_turned_on`, `material_you_turned_off` and drawn-menu usage counts; no new telemetry fields are sent.

- Android Settings subpages change instantly on push and Back. The top-level Settings sheet opens and dismisses
  with its own motion. Material You uses a compact top bar with a Close button.
- Without a connected Mac, Android's redesigned start page shows the Ardia logo. Tap it to open Search. Sync
  setup is available in Settings. Watch `start_logo_taps` in `usage_counts` for how often people use the logo to
  start a search. Incognito taps are excluded.
- The deck's ··· menu has one row height throughout on Android, including when sync and recently closed tabs add
  actions. iPhone keeps its native menu sections.
- After an Android swipe into the deck, the landing or return runs on the UI thread on the iPhone's springs (0.34 s to land,
  0.28 s back, no bounce; a fixed 300 ms timing until 2026-11-20). The live page still follows the finger and remains
  visible until its card can take over.
- Android Settings uses the same General, Search, Tabs, Privacy, Experimental and About groups as iPhone.
  The page menu opens History, Bookmarks and Downloads in Android's Library sheet using the same entries
  and file actions as iPhone. Android still uses its default-browser role and summary provider choices.
- Watch Android's `deck_pulls_hitched` alongside swipe opens and returns, and `library_opened` for access to
  the new Library destinations.



- One design on both phones: Android takes main's iPhone redesign too ("the same look on Android and iPhone … keep one design, not two"). Plan: flip Android to the redesign, run both suites and an Android phone pass, then delete the classic design and its tests in one commit, so there is never a third state. Where a platform has a native element it uses its own: on iPhone the system context menus with lift and blur and the action sheets, behind one JavaScript component. Android draws its menus instead ("Decided by the owner (2026-11-19)"). Android's native needs for the redesign are with the Android agent:
  - Done: Print (7b4330166), the sync-cycle flag (c095acaec), and the site permissions kept, listed and revoked (91d934628).
  - Done: the Downloads list, with preview, share and delete, refusing anything outside the app's own files in Download/ (76285c87c).
  - Done: `Glass` with Classic, its shapes, tint and `shown` fade, and the Mac's synced look (045dea52d). It's behind the lab launch flag `ArdiaNativeGlass` until a phone run compares it with today's drawn surfaces.
  - Done: the page under the bar, Android's way: the page stops at the bars and the page view paints the bands they cover in the bars' own colours, from iPhone's `obscuredInsets` and a new `obscuredColors` (177dfa936; "Deliberately different").
  - Done: every toolkit piece iPhone's Expo UI screens name, in Compose (ddec03ae1): `SettingsShortcuts`, `SpaceTitle`, `SpacePageDots`, `GlassCircleButton`, `PinnedTiles`, `FullScreenCover` and `FilterTextEditor`, the `spaceBackdrop`, `minListRowHeight` and `navigationBarBackButtonHidden` modifiers, and `spaceMenuSymbol`, `spaceSymbol` and `spaceColor`.
  - Undone: Android's own menus and confirmations behind `MenuTrigger` and `confirmInSheet`, a PopupMenu and an AlertDialog (e42837edd), were removed with the owner's decision of 2026-11-19; Android draws its menus and action sheets.
  - Done: the deck's grid on Android, picked in Settings › Appearance › Tabs as on iPhone; `deckGridOffered()` is gone.
  - The page under the bar has no Android counterpart: WebView has no `obscuredContentInsets`, nor any public way to lay fixed footers or the scroll end above an overlay; WebView 140+ only feeds `env(safe-area-inset-*)` to `viewport-fit=cover` pages. The recommendation awaiting the owner: the page stops at the bar's top, and the band under the glass bar takes the page's bottom tone.
- The sync demo gets tabs of its own, kept in memory, and never touches the tester's real tabs. Built: a launch with `ArdiaDemo`, `com.ardia.phone.SYNC_DEMO` or `-ArdiaSyncDemo` runs on an in-memory store seeded from `demoSeed` (eight open tabs with Sintra selected, four archived, seven visits), chosen in one place (`tabDatabase()`). Every tab change goes there: open, close, select, archive, page updates, pictures, scroll positions, received tabs, Move to Space, Close All, remembered page tones and history. It never touches the real tabs, saved states, archive or history, never deletes a real tab's picture or saved page, and doesn't apply the Mac's inbox, so sent tabs wait for the next real launch; usage counts aren't kept. At the next launch without the demo the real tabs are exactly as they were (`render/demoTabs.render.test.tsx` checks it byte for byte). Still shared with the real app in a sync-demo launch: settings, kept links, the telemetry consent, and the engine's website data (Clear Browsing Data in the demo clears it).
- Default Browser: Apple's web-browser entitlement is requested; the iPhone code stays ready to switch on when it is granted. On Android, Default Browser is offered by default (the role prompt), in onboarding and Settings.

- Switching tabs on Android (2026-11-22, a Discord tester: "switching tabs is still fucked, and there seems no easy gesture to switch tabs, unlike the back and forward navigation"). Measured on the F4 with the 1.0.2 code (f5d6f11), 120 fps recordings:
  - The switch waited for the pager's spring to stop completely, about 400 ms after the card had visibly landed: the bar kept the old address and the page didn't answer touches. The pager now lands once the card is within 6 points of its place (`landedNear`, `landsEarly`), about 0.25 s into the 0.26 s critical spring instead of 0.4 s or more, and the arriving card eases the last few points over 90 ms; on Android only.
  - At the switch one frame showed the wrong tab (the tab two over) or the bare backdrop: the pager's offset was reset in an effect after React had already drawn the new tab's neighbours at the old offset. The reset is a layout effect now, and on Android the card the finger brought in stays on top as the arrival (`PagerNeighbour` with side 0, the same instance, keyed by tab) until the page reports its first draw, when the page view hides it in that frame (`ARRIVAL_COVER_ID`, the deck's cover hand-over), at most 400 ms.
  - The page cover then drew the tab's picture one status bar too high for 13 frames and crossfaded it away over 180 ms, so the page jumped. An arrival over a live, loaded page skips that cover (`arrivalCovers`).
  - Finding it: the first time a page has a neighbour, Android plays a one-time hint, the page peeking 56 points toward the next tab and springing back with a toast, "Swipe the bar sideways to switch tabs", once the page has loaded (`tabSwipeHint.ts`, `tabs.swipeHintShown`; with Reduce Motion only the toast shows; it never shows to someone who has already swiped). Chrome for Android has the same sideways swipe on its toolbar with no hint. Watch `tabs_bar_swiped` and `tab_swipe_hints_shown`.
- The owner's tabs pass on a real iPhone (2026-11-17, first built on main's SwiftUI app in 24c1ade07 on `ios-browse-for-me`), in the Expo app:
  - The browsing bar keeps its tabs button (the owner, 2026-11-18: "we should keep the left button coz it look weird"), with its tap and its recent-tabs menu. A swipe up on the bar, once it passes 22 points, is a second way into the deck, from the button, the address or the plus (`barSwipeUp` in `BrowsingScreen.tsx`, `deck_bar_swipes`). On both phones the page follows the finger into its card ("The swipe into the deck" under Deck speed); Android's bar used to open the deck at once. The column layouts keep their tabs button and have no swipe.
  - A space with no icon shows its name alone, with no initial in a circle, everywhere its title is drawn: the deck's header, the start page and the Spaces sheet's header (build 19, the owner on the sheet's "D Default": "why the spaces one has icon left to it? Doesn't make sense"). A space with a symbol or an emoji keeps it beside the name. The space menus' fallback symbol is `<letter>.square.fill`, then `square.fill`.
  - The deck is the stack; Grid is a choice in Settings › Appearance › Tabs ("How your open tabs are laid out. Swipe up on the bottom bar to see them."), iPhone only. The deck's bars have no grid button.
  - The tabs button with one tab open draws its card upright-ish (−4°) in the same 20 × 26 tile box the pair uses, so it sits centred in the circle; it used to hang off the circle's centre because the lone card had no box around it in the glass button's glyph layer (build 16, the owner: "one tab looks bad in the left button"). Android's original bar centred the lone card already, and the box lands it on the same pixels (`render/tabStack.render.test.tsx`).
  - The deck's bottom bar has a 48-point Incognito switch 24 points from the left edge. It draws Arc Search-style
    eyes, open when off and closed when on. The selected fill covers the whole circle, white in dark mode and the
    Incognito card colour in light mode. The browsing bar draws the same glyph during a pull into the deck. The
    pill, cards, Duo controls, search field, address bar and Incognito menus use the thin specs.
    VoiceOver reads the switch's name, state and hint. One tap opens the Incognito deck and the plus opens private
    tabs there. A second tap restores the regular deck and its scroll position. Closing the last Incognito card
    leaves the Incognito deck open. The Archive capsule and Open Archive stay on the regular side. Android's
    standard deck keeps regular and private tabs together. Watch `deck_incognito_switches` for use.
  - The bottom bars sit 24 points in from the screen's sides, up from 12 (build 13, the owner: more side spacing, like Safari's bottom bar but a bit less). Safari's bar on the iPhone 17 Pro Max simulator (iOS 27.0) sits 34 points in on both sides, its back circle and tabs circle 48 points and 8 points from the address capsule, read from the accessibility frames and checked on the pixels; 24 is between our 12 and Safari's 34. One token, `chromeLayout.barSideInset`, sets the browsing bar (`FloatingBar`), the deck's bottom bar (`DeckBottomBar`, and its plus menu's anchor) and the start page's bar (`StartPage`), so the three line up when one turns into another. Since the follow-up to build 13 (the owner: the Space picker and ··· should sit as far in as the bottom row) it also sets the deck's header (`DeckHeader`: the Space picker, the Incognito pill, the ··· and their menus' anchors) and the Archive capsule under it, so the deck's top and bottom rows share one edge, and the grid keeps its 16. The safe-area side inset still adds to it in landscape. Watch `deck_bar_swipes` and `deck_bar_swipes_returned`: a narrower bar shouldn't change how often a swipe up on it lands.
  - Closing a card has no dust cloud. The card flies off the top on main's `flyAway` spring (response 0.32, no bounce), starting at the flick's speed, and the cards after it close the gap in the same frames: the order drops the card at once and a leaving record (`DeckLeave` in `lib/deckGeometry.ts`, timed by one UI-thread clock) draws it until it is off the screen. Closing the last tab lets the card leave before the start screen comes. With Reduce Motion the card fades where it is.

- Find on Page on iPhone is WebKit's own find panel (`UIFindInteraction`), as main's SwiftUI app has, decided from the side-by-side screenshots in `/tmp/ardia-phone-shots/find-on-page/`. The app's own find bar stays for Android, and on iPhone behind the launch switch `-ArdiaAppFind YES` for comparison. `find_opened_system` and `find_opened_bar` count which one opens.

### Waiting on the owner

- Bookmarks in iPhone Spaces: kept (today), or dropped on iPhone as SwiftUI's Spaces has none.
- Reset › Connect Again: acknowledges the reset first on both phones (today), or goes straight on to connecting on iPhone as SwiftUI does.
- A question about iCloud on Android, which the owner is still clarifying; nothing to act on yet.

### For the owner to check by eye

- The deck's moving backdrop beside the old app's.

### Needs only JavaScript

Nothing left (2026-11-15).

### Needs native code on Android

Checked against the log on 2026-11-15. In, and used by the app: the fade view's Android half (4e12b293d); Start
Without Them (248b3f68a, with Compose's per-site settings in 1b33e2c47 and 191db304a); sync connect picking the
folder first (619ede040 on Android, `pickFolder` on iPhone); the launch arguments (4e6ea841a); the keyboard's
target height as its animation starts (5bf60a7fa); the onboarding step across a recreated activity (82d93e298).
Inline completion is in and waits on a phone (the checklist below). Since then, in and waiting on a phone (tester steps 56 to 61): site permissions asking Android first (610f0578d), pull to refresh on Compose's spring and accent with the profile's surface behind a swipe (397f87ce4, fbefd2967), the pager's display corner (9e3bc50f9, 080cb4000), the widgets' Color (9a1014d1f, 35f46a55d), the bar thumbnail taken on the way out (14bbb3d2f; the lag was the 700 ms settle delay), the share sheet with Send to Your Mac (d2ecc1416, its sends counted through 48ce2cb87) and the tray's predictive back (76f0509d3, a1da434a0). What is left:

- Release builds use R8 by default since sync20b (98684363b; `build-apk --no-r8` for the control): 90.1 to 57.6 MB with arm64-v8a and x86_64, both Expo builds; arm64-v8a only it is 38.9 MB (8af216ccb; "Size on Android" has the parts and the Compose release beside them). sync19-r8 passed the F4 with nothing failing on the shrunk build only, and the upgrade pair is built with it.
- At `81776f4d5`, on the POCO M3 Pro (Android 13, MIUI 14.0.6), enabling Gestures under Settings › Additional settings › Full screen display worked. Back from either edge first hid the keyboard, then closed the tray. Menus, submenus, confirmations and Settings also handled Back from both edges. On a Pixel 9 emulator (Android 15), the tray moved with the swipe before closing. The M3 closes the tray on release, as expected on Android 13.

### The iPhone redesign

Since the merge of main, the reference for iPhone is the SwiftUI app on main, redesigned in a2cf29dac (bar, tabs, page menu, Settings, spaces) and d199b885c (motion). It was built as one design variant chosen in one place, the new design on iPhone and Compose's on Android; on 2026-11-15 the owner decided Android takes it too, so the variant goes once Android has passed on a phone ("Decided by the owner"). No scattered platform checks.

What main changed, by screen:
- Page bar: three glass pieces instead of the tinted strip. A 48 pt tab-stack circle, an address capsule (favicon or Not Secure, the host, a `···` page menu button) and a 48 pt plus, 8 pt apart, 12 pt from the sides in main's SwiftUI app (24 pt in the Expo app since build 13's feedback, `chromeLayout.barSideInset`), their bottom 21.5 pt above the edge. Only the pieces take touches; no press scale (`BarControls.swift`, `BrowseTokens.swift`).
- Page view: the page runs full screen under the bar, with `obscuredContentInsets` (top safe area, bottom 75) so fixed footers sit above the bar (33e8709be, ecdeaefc3). Collapse Bottom Bar shrinks the bar to a 30 pt host pill instead of hiding it; Find and the search panel hide it until the keyboard has gone (`BottomBarVisibility`, 53f7bece6).
- Page menu: word rows without icons, icon-only Reader, Copy Link and Share capsules, new Print, History, Bookmarks, Downloads and Site Settings rows, Open in Default Browser on its own (`ToolbarSheet.swift`, `Menu/`).
- Library: one History, Bookmarks and Downloads sheet. History merges this phone's visits with the current space's synced history and remembers deletions per space (`Library/`, `HistoryTimeline.swift`, 68440816a, 6cf89268b).
- Site permissions: camera, microphone and location answers are saved per site and listed and revocable in Site Settings (`SitePermissions.swift`). The Expo iPhone saves and lists them the same way since 942dc45df.
- Deck: header with the space switcher, an Incognito pill and a `···` menu (Archive, Spaces, New Incognito Tab, Reopen, Close All, Settings); bottom bar of a grid button, Search Tabs and plus (the Expo app's has the Incognito switch where the grid button was); a grid view; a slim Archive capsule under the header; cards about 24 pt lower (`TabSwitcherView.swift`, `DeckChrome.swift`, `TabGridView.swift`, `TabsTokens.swift`, `TabsDeckGeometry.swift`).
- Start page: no logo; the space switcher at 0.44 of the height, the space's pinned tiles (4 a row, icon only) and page dots; a sideways swipe changes space. In light mode a themed backdrop gets a 34% white veil (`SearchHomeView.swift`, `PinnedTiles.swift`, `ProfileBackdrop.themeVeil`).
- Tray: a floating glass panel, 8 pt in from the sides and above the keyboard, radius concentric with the field (its inset plus half its height: 9 pt in plus half the 47.5 pt field, 32.75, in SwiftUI; the Expo app derives it the same way from its own field, `searchPanelRadius`); a submitted search lifts it 120 pt and fades it (`SearchTrayHost.swift`).
- Spaces: tabs belong to one Mac space; the deck, the tab swipe and Switch to Tab show the current space's tabs, and the app takes its colour (`TabSpaces.swift`). The Spaces sheet gets the switcher and page dots.
- Settings: an Appearance page (colour, Glass or Classic, Light or Dark, each able to match the Mac through the synced `look`); row icons dropped (`AppearancePage.swift`, `InterfaceStyle.swift`, `SyncedLook`).
- Onboarding: 28 pt bold titles, capsule buttons, rows and tips without icons, faster steps.
- Look and motion: every glass surface goes through `chromeSurface`, so Classic and Reduce Transparency work everywhere; toasts are glass and follow the appearance. Motion is two to three times faster with nothing bouncing (deck open 190 ms, card open spring 0.18); the tab swipe settles over the space's colour.
- Not applicable: the iPhone Duo layouts; widgets, extensions, intents and Spotlight (already in step).

Against the old reference, everything was wired and re-checked on the simulator beside the SwiftUI app (2fbd950ca, dd36012eb): the deck bar on `Glass`, `FadeView`, the system Paste, Default Browser, Open in Background, VoiceOver names, Clear Browsing Data by range, the card handover.

**Audit against main, 2026-11-16** (the iPhone agent, one iPhone 17 Pro lease). Main's SwiftUI app (the ad hoc
Release build of `apps/ios`, which matches `main`) beside a build of head (6cbc6e048), in light and dark, with demo
data. Screens were reached through each app's own UI and the `-ArdiaDemo` / `Browse*` switches. Main reads
`-ArdiaOpenSheet` and `-ArdiaOpenSettings` only in Debug builds, so its sheets were opened by hand. Inventory of
main's screens: an Explore pass over `apps/ios/App`. Pairs (Expo left, main right):
`/tmp/ardia-phone-shots/iphone-audit/pairs/`. Second pass at a1973a86e, light, with typing for real: `iphone-audit/r-e-light/` (Expo),
`r-m-light/` (main), pairs in `pairs2/`, the deck-glass experiments in `glassexp/`.

Status:
- **match**: seen side by side today, light and dark, no difference worth a line.
- **different**: with what.
- **missing**: in main, not in Expo.
- **deliberate**: different on purpose, with whose decision.
- **not seen**: not compared in frames today.

Owner: **screens** (JS), **iPhone** (native), **decision** (needs the owner).

| Area | Screen or state | Status | What | Owner |
| --- | --- | --- | --- | --- |
| Onboarding | Welcome | match | Main's 28 pt title, 17 pt subtitle and capsule button; main's rise, 911cbb80b | |
| Onboarding | Blocking | match | Plain toggle rows on main's card, main's spacing and capsule, 911cbb80b | |
| Onboarding | Sync step | not seen | Art centred as main's (911cbb80b); our demo shows the connected state, main's the connect buttons | screens |
| Onboarding | All set | match | Plain tip rows on main's card, 911cbb80b | |
| Onboarding | All set: usage-stats toggle | deliberate | Expo only; consent is asked where sharing is described (telemetry rule) | owner's rule |
| Onboarding | Default browser step | match | Seen 2026-11-17 with `-ArdiaOnboarding YES` on a fresh install of each: both walk the same four steps (welcome, blocking, sync, tips) into the app, and no step, row or text names a default browser; the code stays off without Apple's entitlement and nothing breaks (`unseen/onboarding-{ours,ref}/`) | |
| Start page | Header, dots, bar | match | | |
| Start page | Space name | deliberate | A title with no chevron and no menu; the dots and the swipe change space, and VoiceOver or TalkBack adjusts the dots. The SwiftUI reference's name opens a menu of the spaces (#2466) | owner's call, 2026-11-18 |
| Start page | Pinned tiles | match | Tiles draw main's SF Symbols (Calendar, folders) at main's sizes, d09343dba | |
| Start page | No spaces, sync off (invitation) | match | The Sync With Your Mac capsule alone, same place and size (`r-e-light`/`r-m-light`/invitation) | |
| Search panel | Empty, recent searches | match | Main's source lists recent searches and the Mac's tabs, no open tab (the audit's SwiftUI row is a Mac tab); rows now refresh live with sync, 2fd28bbe5 | |
| Search panel | Typing | match | Typed for real: app completes to apple.com as main's; main's row and field measures, no glyph before Switch to Tab, 2fd28bbe5. The Incognito toggle is the address bar's thin specs (`eyeglassesThin`, 26 pt) inside the field, where main draws SF `eyeglasses` at 17 semibold; see "Deliberately different" | owner |
| Search panel | Incognito | match | Same panel; the field asks for the dark keyboard in Incognito as main's does (6f1653513 native, the panel passes it since this change) | |
| Search panel | Classic in Incognito, through the morph | match | Seen 2026-11-17 on the iPhone 18 Pro at 006f1afa3 beside main set to Classic by hand: both grow the dark Incognito pill into the same solid dark Classic panel and fold it back into the pill with no tint change (`pr-2184/search-classic-incognito-open.png`, `-close.png`). At rest ours shows the red lock where main shows its eyeglasses: our bar puts not secure before private, and main's frame has no not-secure state on loopback | |
| Search panel | Landed pill on a real site | match | A dim-tap close on en.wikipedia.org at 006f1afa3: the landed pill is whole (favicon, host, `···`) from the first frame it shows. The favicon-only pill for about 20 frames seen on an earlier build (stage-9, 6d88e1c95 plus one native line) doesn't reproduce at head | |
| Search panel | Voice | match | Seen beside main on the iPhone 17 Pro: the same two prompts (speech recognition, then microphone, main's wording), Listening…, "couldn't hear anything" with Try Again, and Cancel, which brings the field back focused with the keyboard up in both (seen again at 006f1afa3; an earlier build left it down). The simulator has no audio, so a spoken search is unheard (`unseen/voice-*.png`, `unseen/ref-voice-*.png`, `unseen/voice-cancel-stage10.png`) | |
| Search panel | Open and close morph (main's PR #2010, e945077b6) | partly | Recorded 2026-11-16 on the iPhone 18 Pro beside main, one still localhost page, stage-4.app (`search-stage-18pro/{open,close,drag,go}-pair.png`). Open stills match: the address selected whole, its start shown, the site row then the typed-address row (363e43f41). Cancel into the pill: level within a frame, the face carrying its whole label (b861cd01e) and the bar back whole. Pull-down: the motion is level (616 ms both), but main folds the panel into the pill at the end and ours fades it in place; the JS sends `morph` with the pull's velocity, so the fold is the native close's (iPhone). Go: main holds the panel about 370 ms before departing up, ours about 170 ms; the JS blurs and closes in one tick, so this too is the native depart's. Open: ours sits about five frames before the panel moves, where main's face rises with the keyboard from the second frame; the native start now waits for the content's layout (e4b1e1739) and the field's late focus is traced by the iPhone agent | screens, iPhone |
| Search panel | Morph: the open's start | match | Seen 2026-11-17 on the iPhone 17 Pro beside main (`stage/{ref,hold2}-open/zoom.png`, the first 24 frames from the tap): the pill lifts off the bar carrying its face, the card deepens behind it with the field's capsule in view, the face fades at frame 17 (main's 16), the field's text at 19 (18) and the rows at 21 (21). Our field had come in about 15 frames sooner: the focus raises the keyboard inside the stage's start, so the reveal fired a turn after the lens opened; the stage now holds it 0.25 s after the unfold, and the reveal covers the field's contents, not its capsule, as main's text field does. At load 15 the keyboard came at frame 9 in both; at load 13 earlier it was late (content laid out 186 ms after the tap, field focused at 661 ms) | iPhone |
| Search panel | Morph: dim tap back into the pill | different | The panel folds down on the keyboard's curve into the pill as main's (`stage/{ref,ours}-dim/strip.png`, 2026-11-17). After it lands, our pill shows only its favicon for about 20 frames before the label comes back; main's pill is whole at once | screens |
| Search panel | Morph: pull-down | match | Both follow the finger with the held lift, fade their contents and fold into the pill from where the finger left them, since 6d88e1c95 (`stage/{ref,ours}-drag/strip.png`) | |
| Search panel | VoiceOver while open | match | Read from the accessibility tree (the simulator does not speak): with the panel open, both expose only the field, Clear Text, Activate Incognito and the rows, in that order, then the keyboard; nothing of the page or the bar. Ours also exposed the dim as a "Close Search" button until the panel became the modal region inside the modal stage, as main's tray is | |
| Search panel | Reopen while closing | not seen | Every open calls the stage's `present()` once its content is mounted, and a reopen mid-close takes the panel back as main's present does; `shown` is only the mounted gate. The bar's capsule hides once `present()` resolves, after the stage has taken its face. Every open starts its ending as a cancel, so a close after an earlier Go no longer departs | screens, iPhone |
| Bar | Side buttons and capsule around the search panel | match | Seen 2026-11-16 in the cancel strip beside main: the capsule hides as the panel takes it and comes back whole after the landing; the side buttons shrink, slide out and spring back, and their glass draws all the way through, since no ancestor of the glass fades (each Glass takes its own `shown`, the glyphs fade) | |
| Page | Page with bar, secure | match | | |
| Page | Not secure | deliberate | The owner's decision, 16 Nov 2026: a red open lock in the site icon's slot replaces main's orange "Not Secure" (see "Deliberately different"); the port is dropped as main's, and a screen reader still hears "Not Secure" | owner |
| Page | Private | match | Same page and bar with the Incognito glasses: a search from the panel with Incognito on shows the glasses before google.com in the pill, light bar, in both (`unseen/incognito-page.png`, `unseen/ref-incognito-page.png`, 2026-11-17) | |
| Page | Loading | match | Main's centred placeholder (44 pt icon, 17 pt semibold title, host), its theme-colour and title rules, 250 ms wait then 150 ms fade | |
| Page | Failure | match | Main's filled Try Again capsule, 50 pt, and the icon at main's size | |
| Page | Page dialogs | match | On iPhone a page's alert, confirm, prompt and sign-in are the system's own (`Alert.alert`, `Alert.prompt` with plain-text or login-password) and a file input's choices the system action sheet, as main's are: the glass alert with a full-width OK capsule, seen on the simulator (`dialogs/`). Android keeps the drawn dialog | |
| Page | Collapsed bar (host pill) | match | Main's glass host pill on scroll down, tap or scroll up to expand, 3fa565c4f | |
| Page | Tabs button menu | match | Main's BarControls: up to eight recent tabs, a divider, Close Tab; Previous and Next Tab are its VoiceOver actions, not menu items. Ours is the system menu with the same items. Since the owner's tabs pass a swipe up on the bar also opens the deck | |
| Page | Find on Page | match by decision | The system find navigator by default since ec6f9bc52 | |
| Page menu | Rows and groups | match | The sheet now reaches the safe top as main's large detent does, and rows land at main's places; the action glyphs are main's size; Open in Default Browser shows, as main's does, only when Ardia can ask to be the default and isn't (hidden in builds without the entitlement) | |
| Page menu | History, Bookmarks, Downloads rows | match | Main's group after Find, Send and Print, opening the Library sheet | |
| Page menu | Translate | match | Main's #2259: the first Translate asks "Translate with Google?", the answer stands, and the row then names the remembered language. Seen on the iPhone 17 at e3be236e1: the question once, then "Translate to English" going straight to translate.goog; an Incognito tab always asks (`ports/06-translate-ask.png`, `08-menu-second.png`). Android has the same through its own `PageTranslation.kt` | |
| Reader | Article | match | | |
| Reader | Top buttons | match | Main's glass circle (textformat.size, label colour) and glass Done capsule, 16 pt from each side; the lead image's 12 pt corners | |
| Deck | Cards, Archive capsule, tab strip | match | The Archive capsule comes back on every deck open until it is dismissed or an interval is picked, as main's `hasShownArchiveCard`, on both phones (Android used to keep Compose's once-on-offer); the Search Tabs placeholder is the system's placeholder tone, within 3 levels of main's in light and dark (`glass-five/grid2.png`) | |
| Deck | `···` and bottom bar (Search Tabs, plus; the grid button moved to Settings in the owner's tabs pass) | match | Glass on all four on every open: no fading parent, Glass's shown, glyphs fade, 34c24a317. Seen at 40fb184e1 over five deck opens in a row, in light and in dark, beside main's: all four surfaces drawn on every open (`glass-five/grid.png`) | |
| Deck | `···` menu | match | The system menu with main's items, place and glass (22045b612); the button's glass since 34c24a317. Reopen Closed Tab follows the same undo rule as main's (archiving and closing are undoable); a fresh demo lacks it only because main's demo seed archives through `archive()`, which fills the undo stack, and ours writes the archived pages straight to the database | |
| Deck | Grid view | match | Main's grid (adaptive columns, title row with close, selected edge, card menu, cross-fade, remembered). It opens centred on the selected tab as laid out (measured cell, viewport and content, one scroll), so its rows sit where main's do on the simulator; the bar's Show as Stack glyph is main's `square.stack`, within 1 pt | screens |
| Deck | Card menu | match | System menu over the lifted card: Copy Link, Share, Send to MacBook Pro, Pin to Mac, Move to Space, Close Tab | |
| Deck | Close | deliberate | The owner's tabs pass: no dust cloud. The closed card flies off the top on a 0.32 s critically damped spring that starts at the flick's speed, while the cards after it close the gap in the same frames; it is dropped once it has left the screen. With Reduce Motion it fades in place | owner |
| Deck | Search Tabs | match | Typing "wiki": the bar rises above the keyboard and the deck narrows to the same Wikipedia tabs (`pairs3/search-tabs.png`) | |
| Deck | Incognito pill | match | Seen 2026-11-17 on the iPhone 17 at e3be236e1 beside main's capture: the dark pill with the eyes and the count, and a private card's header reads Incognito beside the eyes icon instead of the page's title, as main's; before a2724b180 ours showed the page's title and hand-placed eyes (`unseen/deck-incognito/`, `ports/04-deck-incognito.png`) | |
| Deck | Closing the last tab | match | Main's #2261: Close All Tabs, or closing the last card, hands over to the start screen, which rests with the tray down even with Open Keyboard on; the start screen's and the deck's buttons and tiles give the bar's press haptic. Seen on the iPhone 17 at e3be236e1: Close 9 Tabs lands on the resting start screen (`ports/11-after-close-all-3s.png`); the haptic is checked by `emptyDeck.render.test.tsx`, since the simulator has none | |
| Deck | Dark | match | Deck, `···` menu and card menu as in light; once a card showed its placeholder (title and host) where main showed the snapshot, on the first deck open after a fresh install in dark. Not reproduced in two more fresh dark installs (browsing, then Tabs): every card showed its picture (`dark-deck/`) | |
| Spaces | Sheet | match | The Bookmarks section is gone; bookmarks are in the Library sheet. Both show Show All after a device's eighth tab (main's `collapsedLimit`); in main that row sits behind the page dots and is unseen at rest, in ours it shows beside them (`pr-2184/spaces.png`) | screens |
| Archive | Sheet | match | Light and dark | |
| Archive | Row icon | match | Measured at 3x on the iPhone 18 Pro beside main: main's icon sits on the title line, its centre a quarter of its size above the title's baseline (`ArchiveView`'s `alignmentGuide(.firstTextBaseline)`); ours sat with its top on the baseline, since the hosted favicon has no baseline of its own. It is now lifted by three quarters of its size, and its centre sits 14.5 px above the baseline as main's does | |
| Archive | Search field | differs | Main's field is 126 px (42 pt) tall and ours 132 px (44 pt), with the same top; every row below sits the 6 px lower for it, the rows themselves the same 232 px. Both are `searchable(placement: .navigationBarDrawer)`; ours is drawn in Expo UI's navigation stack, and the 2 pt is not in our code. Left until a field of our own, or Expo UI's, sets its height | screens |
| Library | History, Bookmarks, Downloads sheet | match | History, Bookmarks and Downloads seen beside main's, light and dark (`pairs3`, `pairs4`). Ours uses the system toolbar and search field where main hides the bar and draws its own capsules | screens |
| Settings | Root, Sync With Mac, Appearance, Search Engine, Clear Browsing Data | match | | |
| Settings | Site Settings | match | Permissions persist (942dc45df); the permission rows carry main's 22 pt favicons, d09343dba | |
| Settings | Trusted Sites | match | Empty state the same | |
| Settings | Filter Lists | match | The demo now uses main's demo lists (`FilterLists.demo`, as main's AppModel does): a fresh demo install shows 11 lists and 271,481 rules at once, no downloads. Neither app bundles list files: a real install downloads them, and the built-in seed rules block from the first page, network or not (`PhoneBlockingTests`); on the simulator 46 requests were blocked within 5 s of a fresh launch | |
| Settings | My Filters | match | Same editor and footer; the page now takes the settings chrome (the bar in the space's colour) and Apply is the prominent glass capsule, as main's `role: .confirm` draws it, seen on the simulator (`dialogs/ours-myfilters.png`) | |
| Settings | About | match | The app icon since 042a23ace (main's asset catalog); the version reads "Ardia Dev (1)", as current main's AppVersionLabel does for a build without a release version (the reference SwiftUI build predates it) | |
| Settings | Licenses | match | | |
| Settings | Connect pages | match | The connect flow worked end to end on 2026-11-16 | |
| Toasts | Copy Link | match | Neither app shows a toast half a second after Copy Link in the page menu; both keep the menu open. Other kinds not seen | |
| Extensions, widgets, intents | | partly | The Expo project compiles main's own sources for these. Seen on our build 2026-11-17 (`unseen/widgets/`): the gallery offers main's four widgets (Search small and medium, Your Mac's Tabs medium and large, with the demo Mac's tabs in the previews); the large one on the home screen shows "Sync With Your Mac" without a synced snapshot (demo mode writes none) and a tap opens the app on the Spaces sheet with the Mac's tabs. Main's tap does the same (`unseen/widgets/ref-p4/`). The share sheet, seen 2026-11-17 on the iPhone 17 at e3be236e1 beside main's from Safari with no Mac connected: the same sheet in both, the page's title and host, Open in Ardia and the line about turning on Sync With Your Mac, its top edge on the same pixel row (`ports/30-ref-share-1.png`, `32-ours-share-b.png`). Not seen: the widgets in dark, and the share sheet's Send to Your Mac row with a Mac connected (the demo writes no snapshot; the row and the exporter are main's own sources) | iPhone |
| Duo | Closed and open take `phone`; only a half-open horizontal fold takes `split` | partly | Since #2840 (2026-11-20) the closed and open Duo show the page full screen, as any iPhone, seen on the Duo simulator. Their bottom bars follow Safari's on the closed Duo, with our page still full screen (the owner, 2026-11-20): closed, `+` and Tabs stacked in the strip with the address capsule along the bottom 24 to 370, never squeezing; open, three fixed slots in the strip (`+`, Tabs, and the `···` the 400-wide capsule grows out of, 527 to 927), the capsule squeezing into that `···` on scroll by default; the deck's Search Tabs is a circle in that slot that grows into the field, keyboard-wide while typing; on either Duo the search panel ends 8 short of the strip so it clears the clock. Checked in `bottomBarSpan.test.ts` and `landscape.render.test.tsx`, not yet seen on the simulator. `split` is not seen yet: Simlock leases the iPhone Duo folded only: `fold open` needs a simulator in the default set and Simlock's are in a scoped one (2026-11-17). Later the same day Simlock's Duo did not boot at all (two tries: a boot timeout, then a closed connection), and a Duo simulator made in the default set is not offered by the Device panel, so the layouts are still seen only under `-ArdiaDuoCanvas` on the iPhone 18 Pro (the row below) | |
| iPhone in landscape, Duo layouts | | partly | Decided 2026-11-16. Built to the specification below. `phone` in landscape (db4823c0f and this change): every bar pads by `max(left, right)`, the deck takes main's landscape card, and the archive capsule now swaps the deck to main's archive geometry (407.6×188 at 852×393; 273.2 wide in portrait on a 402×874 iPhone), springing from the old card as main animates it. Seen on the iPhone 18 Pro simulator turned on its side: browsing, the deck with and without the capsule. `wide` (a full-screen iPad) and `split` (a half-open Duo) are built (components/duo) and switch from the native probe (44797e4ed); under `-ArdiaDuoCanvas` on the iPhone 18 Pro each draws, but the 669×951 canvas overflows that screen, so their sizes still need the iPhone Duo simulator. The closed and open Duo take `phone` since #2840 (the owner, 2026-11-20); the `column` layout that the closed Duo had is gone. Simlock's Duo can't fold or turn (its scoped simulator set has no hinge), so `wide` and `split` are checked by tests only (duoLayout.test.ts, duoWide.render.test.tsx, main's numbers), not yet seen at their real size: this Mac's default-set Duo holds someone's install of main and is left as it is, until the owner names a Duo that may be folded. The command bar keeps its greatest height as main's does (main's rows take `rowsBudget`). Not matched yet: the status bar in `wide` follows the backdrop rather than the page's top tone | screens |

**Motions from main's pass (d199b885c)**:

| Motion | Status | Where it stands |
| --- | --- | --- |
| Deck open (`arrive`, 190 ms) | timed | 137 against 237 ms, faster |
| Card open (`expand`) | timed | 177 against 172.5 ms, level (383c8517d) |
| Search panel rise (360 ms) | timed | 418 against 578 ms, faster |
| Panel departure on Go (`depart`, 120 pt, 200 ms) | timed | The screens agent's strips (`lift-sim-58`) |
| Tab swipe settle (`smooth`) | timed | 800 against 848 ms, level |
| Pager swipe, release to rest | level | 13 frames (433 ms) in both, re-recorded 2026-11-16 (pager.mp4) |
| Onboarding step | level | Both slide 72 pt and fade on main's `step` curve (0.05, 0.7, 0.1, 1 over 0.3 s), 911cbb80b. Main keeps the leaving step above both backdrops (its zIndex 1); ours had no order, so the steps' backdrop, fading in fast, covered the leaving welcome within a frame. With main's layers the welcome's icon and title fade over the new step for about four frames against main's five (`onboard-step/strips2.png`) |
| Welcome appear (`rise`, 50 ms delay) | level | Three alternating cold launches each, from the tap: the system's icon zoom (0 to 300 ms), then the white launch screen in both. Main's backdrop fades in from about 1,200 ms; ours showed white until about 1,450 ms (JavaScript starting, as on Android). The welcome itself is level: both start it at about 1,470 ms and settle at about 1,700. Since the launch backdrop (React Native's loading view drawing main's themed `ProfileBackdrop` in the last start page look), ours fades from white at about 1,050 to 1,250 ms and settles at 1,600 to 1,650 against main's 1,670 to 1,730 (`iphone-audit/launch`, `launch2`). The single 0.8 s run was a first launch under load; three first launches each settle at 1.8 to 2.1 s against main's 1.75 to 2.5 s |
| Pager background in the space's colour | match | Both phones paint the space's surface behind a swipe between tabs, as main's look.surface (d09343dba on iPhone; Android drew black before) |
| Loading line (0.15/0.3/0.15/0.2 s, 100 ms delay) | level | Seen on Android; on the iPhone 18 Pro simulator, a localhost page that answers in 0.8 s and holds two images 1.5 s, opened with the keyboard's Go in both apps: the line appears about 0.1 s after Go, holds near a tenth of the width while the page waits, then fills and fades within about 0.3 s, the same at 10 fps sampling (`loadline/band-pair.png`); the four segments aren't separable at that rate |
| Close fly-away (spring 0.32, from the flick's speed) with the gap closing (`gapClose`) | seen | The owner's tabs pass; frame sheets in the change that brought it |
| Placeholder fade-out (0.12 s) | not seen | |
| Archive capsule yielding, grid cross-fade | not seen | No grid in Expo |
| Search panel dim, dismiss, settle, results-in, surface swap and fade | dismiss level | Over a page: rise 430 against 600 ms, dismiss 270 against 300 ms (panel.mp4); dim, settle and results-in not separated |
| Press scale (`press`, 0.16) | level | A start tile held: the press runs about 20 frames in both, and the system menu arrives in 10 frames against main's 13 (tilepress.mp4) |
| Spaces backdrop (`smooth`) | level | Native `spaceBackdrop` uses `Motion.smooth`. Two swipes each way in the Spaces sheet, at a quiet load: ours changes colour in 167 to 267 ms, main in 167 to 300 ms, each pair within a frame or two (`spaces-backdrop/`) |

Telemetry the redesign adds: space switches, Search Tabs, the grid, the appearance choice.

#### Moving parts not yet seen in frames

Nothing here is done until it has been watched in the screens agent's own simulator frames beside main's SwiftUI app. Strike a line only with the frame sheet's path.
- Search panel: the lift and fade on Go and on a row (frozen on the simulator through 2026-11-15; the page's loading line, then on React Native's JavaScript-driven Animated, committed every frame and held Reanimated's commits; the fix waits for the simulator in `screens-depart8`).
- Start page: the tray-up fade and 0.96 scale, and the Reduce Motion fade without the scale; the bar fading out with it.
- Start page: the sideways space pager; the page dots' colour change.
- Start page: a folder tile's menu, a tile's Copy Link and Share menu, the plus menu.
- Start page: the tile press, which dims in place with no scale (main springs a scale with `Motion.press`; the owner's motion rule keeps it plain); the glass of the tiles, bar and capsule; the light-mode veil in the drawn fallback; the bar glyph sizes (estimated from SF sizes 16 and 18).
- Deck: the `···`, space and Incognito pill menus; the pill appearing and leaving (fade, 0.9 scale spring); the Archive capsule's entrance and exit, its interval picker, and the cards' 26 pt spring down and back, easing to zero as a card opens.
- Spaces: the deck on a space switch (order reset, scroll to the second-last card, cards fading in, the archive card); the two-step card menu (Move to Space, then the space list); a moved card leaving and the gap closing; the swipe neighbours after a switch; the page changing to the new space's latest tab, or the start page for an empty space; the colour change; Switch to Tab on another space's tab (for a moment it may have no swipe neighbours until the sync event arrives).
- Appearance: the page's push and pop, the swatch ring; switching Glass and Classic live on open surfaces (the native `Glass` must take a `surface` change at runtime); switching Light and Dark live across windows, sheets, the keyboard, the status bar and pages' `prefers-color-scheme`, and back to System; Match My Mac following a new synced look; Reduce Transparency switched on while open; Night Shade Automatic following the app's scheme.
- Sheets with Remove animations on Android: Settings, Spaces, the archive and the small sheets come up and go at once, as Compose's do (the system scales Compose's durations to zero); with Reduce Motion on iPhone they still move on a 200 ms timing.
- Page menu: the sheet opening and closing on its white or black fill and its drag; the tiles' in-place press dim (no scale) and glass; row press highlights (instant, where main fades them over 0.2 s); the title feedback crossfade; the print sheet after the menu has gone; the Send to Device menu's place; Site Settings opening as the menu slides away; the accessibility-size layout.
- Tray field on the way out: from the first frame the tray leaves, its text shows as plain text with no caret (the native field is blurred and dropped), on both phones; check it doesn't jump or change size.
- Page load motion moved to the UI thread: the page's loading line (now a scaleX from the left edge where it animated its width, and fed from the store without renders) and the settings switch's knob and colour (now Reanimated). Seen on the F4 (`/tmp/ardia-phone-shots/loadline-proof/`): with a page loading, slow UI-thread frames 286 to 202 and janky 10.85% to 10.35%, the deck open's worst stall 108 to 92 ms; the card open keeps a 100 ms stall in both builds (another cause, the hand-over). Still to see on iPhone: the search panel's lift no longer frozen (`screens-depart9`).
- Deck: the bar rising above the keyboard and back; Search Tabs typing (the gap-close, the scroll to the last match, the keyboard hiding on a tap); the plus menu above the new bar; the header and bar fading with the deck's open and close; the glass on the new pieces and the grid glyph.

The owner's decisions on these (native menus on both phones, the entitlement requested) are in "Decided by the owner".

#### Landscape and Duo: the specification

Decided 2026-11-16: main has landscape and the Duo layouts, so the Expo app gets them, after the three missing screens
(Library, deck grid, collapsed pill). Read from main's source at d2d73b04a (`apps/ios/App/Duo/*`, `RootView`,
`BrowsingView`, `BottomBar`, `WebPageView`, `TabSwitcherView`, `TabDeckBar`, `DeckChrome`, `SearchTrayHost`,
`SearchHomeView`, and the tokens in `ArdiaDesign/{BrowseTokens,TabsTokens,TabsDeckGeometry,Tokens}.swift`). Native
side: the iPhone agent. Screens: the screens agent. Numbers are points.

**Orientations.** On iPhone, portrait, landscape left and landscape right; never upside down. On iPad all four,
so the app takes part in Split View and Slide Over (`TARGETED_DEVICE_FAMILY = "1,2"` on the app and its three
extensions, no `UIRequiresFullScreen`). In Expo that is `UISupportedInterfaceOrientations` and
`UISupportedInterfaceOrientations~ipad` in `apps/phone/ios/Ardia/Info.plist` (by hand: `app.json`'s `"default"` would
add upside down on iPhone; `supportsTablet` there only records the choice). An iPad window at least 600 pt both ways
gets the `wide` layout; a narrower one (a Split View third, Slide Over) gets `phone`, from the same probe
as the Duo, never the device model. A new device joining sync on an iPad is named "iPad" (`SyncMeta.deviceName`).
From @mantrakp04's #2263 on the SwiftUI app. In a window (Windowed Apps, Split View, Slide Over) iPadOS draws its
window controls over the window's top-left corner; `WindowControlsClearance` (SceneDelegate.swift) adds the extra the
corner-adapted safe area asks for (43 pt on an iPad Pro 11-inch) to the root view controller's top safe area, so
every top inset in the app clears them, measured on the window so it never reads its own addition. A page resting at
its top stays there when its top clearance changes, so a window growing from `phone` to `wide` keeps the page under
the toolbar (`PageView.applyObscuredInsets`). Android rotates too, as
the Compose app does: see "Android's half" below.

**Choosing a layout** (`ScreenLayout.resolve`). It reads the safe-area size, the hinge and the fold rectangle;
never size classes, orientation or the model. The keyboard never changes it. Checked in this order:
1. Hinge partly open and a horizontal fold (a division at least half the screen wide, wider than tall): `split`,
   with `fold.top = rect.minY + safeTop` and `fold.bottom = rect.maxY + safeTop`.
2. Any other hinge (closed or fully open): `phone`.
3. Safe-area size at least 600 by 600: `wide`.
4. Otherwise `phone`.

The Duo, closed and open, takes `phone` since #2840: the owner's decision on 2026-11-20, after a tester said the
old full-screen view was better. Before it, the closed Duo took a `column` layout (the page stopped at the 84-point
sensor strip, with round buttons in the strip) and the open Duo took `wide` (the page in a card under a toolbar).
The `column` layout is gone, and `-ArdiaDuoCanvas column` with it. The probe on the Duo simulator (iOS 27.1) knows the hinge
from its first report: closed 382×644 with trailing 84, open 867×635 with trailing 84. Only a half-open Duo with a
horizontal fold keeps `split`; half open with a vertical crease takes `phone`, as the simulator reports it. A
full-screen iPad (no hinge) keeps `wide`. An ordinary iPhone in landscape stays `phone`.

A layout change is not animated: views swap at once. Pages are not reloaded (the web views are re-parented), the
open search tray stays, and app state (tabs, surface, grid, sheets) survives. Going between `phone` and `wide`
resets the browsing view's own state: the bar comes back expanded and the sidebar closes. A plain rotation stays
`phone` and keeps everything, the deck's scroll included.

**`phone`, which is also iPhone landscape.**
- Page: full screen under the safe area. Obscured insets top = safe top, bottom = bar height 75, left and right 0,
  re-applied whenever the safe area changes (rotation). In landscape the safe top is 0 (no status bar), so the
  status-tone strip is 0 high.
- Bar: stays at the bottom, one row (tabs circle 48, address capsule 48 high and flexible, plus circle 48), gap 8.
  Horizontal padding = `max(left, right)` + 24 (`chromeLayout.barSideInset`; 12 before build 13's feedback) on
  **both** sides, so the bar stays centred; no maximum width (852 wide with 59 insets gives a 574 address capsule). 21.5 above the bottom edge, ignoring the safe area. Collapsed
  pill unchanged (30 high, at most 240 wide).
- On a Duo (the probe reports a hinge) the bottom bars follow Safari on the closed Duo (`bottomBarLayout`, the owner,
  2026-11-20), except that our page stays full screen where Safari's stops at the strip. The strip's buttons are 48
  glass circles centred `min(48, inset − 24)` from its edge, 7 apart; a strip on the leading side mirrors it all, and
  menus open beside the strip buttons. A strip needs a side inset of at least 48, the circle's width: under that (a pose
  reporting no side inset) there is nowhere to put a circle clear of the capsule, so the bar is the plain centred one
  of any iPhone. The hinge picks the sizing: a closed hinge is always the closed bar, even turned on its side, and a
  fully or partly open one at 600 wide or more is the open bar.
  - **Closed** (under 600 wide): Tabs on the bar's centre line, `+` 55 above it. The bar row keeps only the address
    capsule with its `···`, from 24 to 12 short of the strip (24 to 370 on 466). The start bar keeps Settings in that
    span; the deck bar keeps the Incognito switch and Search Tabs there, its `+` in the strip on the bar's line. It
    never squeezes: with Collapse Bottom Bar on it folds into the host pill as any iPhone does, strip buttons
    included, and with it off it never collapses.
  - **Open** (600 wide or more), from the owner's sketch: three fixed slots, `+` 110 and Tabs 55 above the bar's line
    and the bottom slot on it; `+` and Tabs never move. Expanded, the 400-wide capsule grows out of the bottom slot,
    its right end and its `···` on that slot (527 to 927 on 951). Scrolling down, whatever Collapse Bottom Bar says,
    moves only its left edge into the slot (on `barCollapse`, the host pill's spring) while the host fades, leaving
    the `···` circle; it opens the page menu (never expands the bar), shows the red open lock on an insecure page,
    is read as "Page Menu, <site>" and anchors the search tray. Scrolling up grows it back. The deck puts its `+` in
    the top slot, the Incognito switch in the middle one (where the page's Tabs button turns into the Incognito
    glyph as the deck pulls in) and Search Tabs as a 48 magnifier circle in the bottom slot that grows left into the 400-wide field when tapped (on the same spring, focused, counted in `search_tabs_opened`), runs from 24 to the slot while the keyboard is up, and shrinks back once the search closes empty; the page's capsule hands over to it on the same slot as the deck pulls in; the start page puts `+` and Tabs in the
    top two and Settings in the bottom slot. On either Duo the search panel keeps 8 from the safe edges, so it ends
    short of the strip and its clock. Closing search on the open Duo lands the panel on the capsule in one move
    (`landsDirectly`): the phone's drop, fold and then narrow read as a second slide there, the panel being twice
    the capsule's width and off to its left. Each open Duo collapse counts in `bottom_bar_collapses`. The deck's header, cards, grid, archive capsule and the search tray keep
  the side insets.
- Pager: the full screen width.
- Search tray: the panel is the safe width less 8 each side, so it clears the island; radius `searchPanelRadius` (the
  field inset plus half the field's height); placement, height and the keyboard gap come from the same
  `searchPanelPlace` and `searchPanelPreferredHeight` as on the phone (see the new-tab search panel entry), with the
  height also capped by the room above the keyboard, which usually wins in landscape.
- Deck: side padding `max(left, right)` for the header (+24), the Archive capsule (+24), the bottom bar (+24) and the grid (+16).
  Cards take the screen's aspect: `cardW = min(W·306/440, band/(H/W))`, with `bandTop = chromeBottom + 41`,
  `bandBottom = H − max(safeBottom, 20) − 43`, band at least 120; `focusLeading = W·66/440`,
  `spacing = min(cardW, W·218/440)`, `barCenterY = H − max(safeBottom, 20) − 11`. Check at 852×393, safe top 0,
  safe bottom 21: card 520.3×240, centre y 209, focus leading 127.8, spacing 422.1, bar centre 361; with the archive
  card, 407.6×188.
- Start page: `safeSide = max(left, right)` as now; nothing else changes. Main lets a second row of tiles run into
  the page dots at 393 high; match it, and note it as main's.
- Page menu, share sheet, Settings, Archive and the other sheets: the system's, no landscape rules.

**`wide`** (a full-screen iPad, 600 both ways, no hinge). The deck is never shown; the start page keeps the phone arrangement.
- Card: x = 11 + left, y = `max(33, safeTop + 4)`, width `W − 22 − left − right`, bottom margin
  `max(9, safeBottom − 20)`; radius 16 continuous; shadow black 0.12, radius 10, y 2. The page inside has no bar; its
  content inset and obscured top are 63 (toolbar 45 + 9 above and below), bottom 0.
- Toolbar at the card's top + 9, card wide, padding 8, gap 7: back, forward, reload or stop as 45 circles with 18
  medium glyphs; the address capsule (44 high, leading 8, trailing 20, inner gap 10, a 30×44 sidebar button with a
  17 glyph, the host at 15 with a 13 lock, capped at xxLarge) centred between spacers; share and `···`. The capsule
  hides while the sidebar shows. The toolbar's scheme follows the page tone at the top.
- Sidebar over the card: a black 0.12 dim over the screen (tap hides); 260 wide, `H − 11 − bottom margin` high, at
  x = 11 + left, y = 11; radius 16, filled with the look's surface (Incognito's sheet colour in Incognito); shadow
  black 0.18, radius 18, y 4. Header 50 high from 25: the space switcher, `···` (44) and the sidebar button (44).
  Address field 43 high, padding 10 outside and 18 inside. Spaces page sideways when there is more than one. Pinned
  tiles 2 a row; "Today" heading (leading 19, top 16, bottom 4); rows 41 high on a 46 pitch, radius 11, lead 13,
  icon 18, gap 12; the selected row glass with a 44×41 close (xmark 13 semibold); a New Tab row; dots 8 above and 26
  below. Slides with `smooth`; under Reduce Motion an opacity change over 0.2 s.
- Entering `wide` with the deck up: a selected tab goes to browsing and, with no fold, the sidebar opens. Picking a
  tab browses it; starting a search or a fold change hides the sidebar; hiding it from the deck with no tab selected
  goes to the start page.
- Search is a command bar instead of the tray: top = card top + 127 − safe top, side padding 27 + 8, height at most
  `min(484, keyboardTop − top − 24)`; top-anchored, fading in from 0.96 scale; no resting drop.

**`split`** (a half-open Duo with a horizontal fold). Card x 11, width `W − 22` (side insets unused), y the card top, height
`max(fold.top − y − 11, 120)`; toolbar without the address. Below the fold, the sidebar as a panel `W` by
`H − fold.bottom`, bottom padding the safe bottom, no background (the backdrop shows), no tiles, header from 16, no
sidebar button. Search uses the phone tray.

**Safe areas in landscape.** The page runs under the island. Every bar (browsing, deck header and bar, start bar
and tiles) pads by `max(left, right)` on both sides; the tray uses the safe width. The browsing bar sits 21.5 above
the edge, the deck and start bars at `max(safeBottom, 20) + 11`.

**Android's half**, read from the Compose app (`apps/android`, 2026-11-16). The owner's app rotates on both phones;
the Compose app has no orientation lock.
- **Orientation.** Compose's main activity declares no `screenOrientation`, so the whole app follows the phone: it
  turns with auto-rotate on and stays put under the user's rotation lock. Upside-down portrait comes only where the
  system offers it, which phones usually don't for apps.
  - Its `configChanges` take orientation, screen size, smallest width and layout, so a rotation recreates nothing.
  - The Expo app's `MainActivity` is locked to `portrait` in `apps/phone/android/app/src/main/AndroidManifest.xml`;
    the lock goes. Its `configChanges` already cover rotation.
- **Fullscreen video.** Compose hides the system bars (transient by swipe), asks for no orientation, and the video
  turns only as the whole app does. It ends on Back (the first thing Back closes) or when the page leaves
  fullscreen. **Rotation never ends it.**
  - Expo's `FullscreenHost` asks for `FULL_USER` while a video shows and puts back the portrait it found on exit
    (e1c2afc18).
  - On the F4 at expo58j, rotating back to portrait kept the video fullscreen, as Compose does. At expo58i it had
    ended fullscreen. What changed between them was the inset hold keeping the covered page's insets steady (the
    likely cause, unproven).
  - Once the manifest lock goes, `FullscreenHost` asks for no orientation at all.
- **Layouts.** Compose has no separate landscape layouts. Every screen sizes itself from its window and the safe
  drawing insets:
  - **Deck:** `TabsDeckGeometry(window, safeTop, safeBottom, safeSide = max(left, right))`, main's earlier Swift
    formula. Its test pins 852×393, safe top 0, safe bottom 21: card 592.5 wide, spacing 422.1, left reach 70.2,
    card centre y 185. Main's current formula, above, gives a 520.3 card. Follow main's, and note the difference.
  - **Archive and Spaces:** pad by the safe drawing insets, top and sides, with the bottom as content padding.
  - **Sheets:** full width, status-bar padding on top, at most the window height less 24 dp, navigation-bar
    padding inside.
  - **Find bar and reader:** navigation-bar padding.
  - **Page pager:** the window's width.
- **Insets in landscape.** With 3-button navigation, landscape moves the navigation bar to a side (about 47 dp on
  the F4), next to any cutout; gesture navigation keeps it at the bottom. `max(left, right)` covers both cases.
  - The inset hold (`InsetHold`) holds only a navigation bar dropping to zero at a light/dark change. A rotation
    ends any hold, so the new side inset gets through at once (F4, expo58j: the video filled landscape, and the deck
    never saw a zero).
- **Not read yet; check on the F4 once the lock is gone:**
  - the side padding of Compose's browsing bar;
  - what Compose does when turned with the deck mid-scroll;
  - the Expo app at 2400×1080 with the navigation bar on a side.

**What Expo has to change.**

| Piece | Change | Owner |
| --- | --- | --- |
| `apps/phone/ios/Ardia/Info.plist` | The three orientations (done, 76f5df8c8) | iPhone |
| `apps/phone/android/app/src/main/AndroidManifest.xml` | Drop `screenOrientation="portrait"` from `MainActivity` | Android |
| `FullscreenHost` (`packages/phone/android`) | Ask for no orientation once the lock is gone; never end fullscreen on rotation | Android |
| `PageView` (`packages/phone/ios`) | Done: `obscuresSafeTop` takes the obscured top from the view's own safe top, re-applied on every safe-area change, as main's `applyInsets`; `topClearance` (63 in `wide`) sets the scroll view's top content and indicator insets and adds to the obscured top | iPhone |
| Simulation | Done: `<ScreenLayoutProbe onLayoutChange>` (mounted full screen) reports `layout`, `fold {top, bottom}` (screen points, safe top added), `canvas`, `forced` and the raw space (the hinge included), once per settled change; tested in `ScreenLayoutTests`. In test builds `-ArdiaDuoCanvas wide\|split` (main's `open` and `half` too) forces a layout on a 669×951 canvas with the fold at 465.5 to 485.5; reports log as `ARDIA_SCREEN` | iPhone |
| `App.tsx` | Resolve the layout from window size, insets and the probe; swap in the Duo view | screens |
| `FloatingBar`, `BottomBar`, `barGeometry` | Pad by `max(left, right)` | screens |
| `PageSurface`, `TabPager` | Insets and pager width on rotation; the `wide` clearance | screens |
| `TabDeck`, `DeckHeader`, `DeckBottomBar`, `deckGeometry` | `safeSide = max(left, right)` (it passes 0 now); the landscape card formula | screens |
| `SearchTray` | Side safe area; the `wide` command bar | screens |
| `Sheet`, `FullSheet` | Check width and height in landscape (main uses system sheets) | screens |
| New | Duo toolbar, sidebar, card | screens |

**Shared pieces (2026-11-22).** Screens build their controls from `components/ui` instead of local copies, so a
look changes in one place:
- `Tappable` and `usePressStyle`: the one pressed and disabled look for a plain press (rows fill with `rowPressed`,
  text, icons and filled faces dim; nothing moves), with the role, label and state; it replaces each screen's own
  `pressed ? …` styles and the presses that had no feedback.
- `ActionButton` (and `PrimaryButton`, its hero accent form): retry, recovery, primary and secondary actions with one
  set of sizes, corners and a busy state; it replaces Sync's capsule buttons, the failure screens' buttons and
  onboarding's own buttons.
- `ToggleRow` and `Toggle`: one switch row with a checked state; it replaces the page menu's and onboarding's rows
  and their own greens.
- `FieldAccessory` and `ToggleIconButton`: Clear Text, Voice and Incognito in a field, inside a 44 pt target; they
  replace each field's own small buttons.
- `ModalOverlay` and `useModalOverlay`: full-screen overlays (Reader, the scanner, voice, onboarding's steps) are
  modal for screen readers, take first focus, give it back, close on Escape and stop taking touches the moment they
  start closing.
- `ListStates` (`EmptyState`, `NoResultsState`, `LoadingState`): one empty, no-results and loading look for the
  Archive, Library, Spaces, the deck's filter and Reader's No Article Found.
- `lib/sharedWords.ts`: one wording for labels that repeat across screens (New Tab, Clear Text, Stop Loading, More,
  Copy Link and Copied Link, Share, Spaces, Connect to Your Mac, Enter Recovery Phrase, Done, Cancel, Close); it
  replaces Synced Tabs, Options, New Search, Copied URL, Share… and Enter Words.
- The accent roles (`ui/accentRoles.ts`): `spaceAccent` fills, `onSpaceAccent` for what sits on a fill,
  `spaceAccentInk` for accent text and `spaceAccentGlyph` for accent edges and checks, each checked for contrast; they
  replace drawing everything in the raw space colour.
- Also shared: the browsing address face (`AddressFace`, used by the wide toolbar and sidebar too), the page's
  progress line (`PageProgressLine`), the icon roles (`lib/iconRoles.ts`, one glyph per meaning), the elevations
  (`shadowCss`) and a toast's action label, spoken and shown in place of a chevron.
- Round 3 added:
  - `PressInPlace`: the press for everything touched all day (bar buttons, the + controls, the page menu's tiles, tab
    cards). It dims in place on contact and never scales (the old `PressScale` name is gone). The only things that
    still scale under a finger are the start page logo's drag and the page and deck morphs.
  - `PlusMenuButton` (`tabs/ChromeButtons.tsx`): one + control for Start and the deck, with the glyph, chrome
    surface, press, haptic, long-press hint and the + menu; Start passes its wide pill width and menu anchor, the
    deck its 48-point circle and fade inputs. The browsing bar's + keeps its own face for the swipe's pull glyphs.
  - The glass `ActionButton` face (`variant="glass"`, `tone="overlay"`): the overlays' Search, Done and Browse share
    the action's busy and disabled contract over a frosted plate.
  - `primaryActionRoles` (`ui/tokens.ts`): the named hero, full and compact roles (height, corner, fill, ink, native
    control size). `ActionButton`, `PrimaryButton` and the native Expo UI adapter all read them.
  - The loading contract: drawn and native loading states share one role, busy state, default label (`listWords`)
    and one announcement; Reader passes its own ink and label.
  - `IncognitoLook` and `incognitoTheme`: one private accent (`PRIVATE_ACCENT`) for Start, the deck and the search
    tray, never the profile's colour.
  - Focus return: `useModalOverlay` takes `returnFocusTo` and gives focus back after the cover clears; Reader returns
    it to the page menu button that opened it (`openPageMenuFrom`), the drawn scanner (Android) to Scan Code, Voice to
    its mic (on Material You to the search bar, since Compose draws the mic). The iPhone scanner is a full-screen
    React Native `Modal` over the SwiftUI connect page, so it settles focus from the modal's `onDismiss` instead
    (`afterScanner`, `ExpoSyncConnectPage.tsx`): Cancel, VoiceOver's Escape and the system close go back to Scan Code;
    a scanned code goes to "Recovery phrase added", and with a folder already chosen the connection starts only after
    that focus request, so a connection that succeeds at once cannot close the page first; Enter Recovery Phrase pushes
    its page only then, so the pushed page takes focus as any pushed page does. The native side is
    `accessibilityFocusRequest` (`settingsUI.tsx`, `SettingsUIModule.swift`), a counter that moves VoiceOver focus to the view each time it goes up.
  - The native busy action (`ExpoSettingsAction`) keeps one button mounted, idle or busy, with the spinner beside it
    and hidden from VoiceOver, and keeps the title it had when the work began (Choose Folder stays Choose Folder
    while the first pick connects).
  - Native URL rows (`ListRow`, `listSheet.tsx`) measure their title's width (`onWidthChange`, width only, so
    scrolling sends nothing) and `listRowTitleLines` gives a title narrower than 240 points per unit of text scale a
    second line; large text keeps its three.
  - `plateMaterial`: one rule for a plate's material (glass, frost or solid); the search panel and its native morph
    both follow it, and a solid (Classic or Reduce Transparency) panel draws the bars' chrome edge on its face and in
    its morph (`classicChrome`, passed across the bridge as `morphClassicChrome`).
  - `incognitoWords` and `blockingWords` in `lib/sharedWords.ts`, with a test that fails when a shipping file writes
    a shared word out as its own literal.

### Tester checklist for the next build

Everything nobody has yet seen working on a phone, in the order a tester meets it. Each line is what to do, then
what should happen. Lines marked **Android** or **iPhone** are for that phone only; the rest are for both. Note the
build's `PAGELAB build` line first, and for a line that fails, keep a screen recording and the time. Android's
own scripts stay as they are ("System entry points on Android", steps 1 to 55, and "Upgrade from the Compose app
on Android"); a line here points at their step where one covers it. The deck's four motions (card open, deck open
from a page, closing, a reloading tab) are not here: they are being matched to Compose frame by frame on the F4.
iPhone lines on screens main's redesign changes ("The iPhone redesign") are checked again once those land.

Already seen on a phone, so not here: closing tabs from the deck and the last tab with no crash, ANR or JS error
(40 closes on sync15); the Archive card and the + menu above their buttons, and Inactive Tabs shown once; no
missing card on long flings; Go with no completion closing the tray and keyboard; a drag down from the field or
the top edge leaving no keyboard and no dim; the tray's fourth row peeking and a slide under the keyboard opening
it; one tab per Go before and after a connected upgrade; a typed tab not coming back from the Mac; a sent tab
arriving by itself; an idle deck drawing no frames; flick and menu closes using the same poof; a deck opened from
a page with no title-and-host placeholder (sync15); the bar frosts taking the tinted path. On the iPhone
simulator, the list under "The iPhone redesign".

**1. Install and upgrade**
- [ ] **iPhone:** before updating the SwiftUI app, note a Trusted Site, a My Filters rule, one site's page zoom, Night Shade, the Open App Links In choice, a few tabs and one archived tab, with Sync connected; install the Expo build over it and open it. Expect: no onboarding; the same tabs, the archived one in the Archive; that site's page menu shows its zoom, Night Shade and blockers off; Settings › Sync still shows the Mac.
- [ ] **iPhone:** relaunch twice. Expect: nothing appears twice.
- [ ] **iPhone:** open the deck, then update the app once more and open it again. Expect: imported cards keep their pictures both times.
- [ ] **Android:** the upgrade script ("Upgrade from the Compose app on Android") if this build hasn't had it.

**2. Onboarding** (a fresh install, or a lab build launched with `ArdiaOnboarding`)
- [ ] Go forward and back through every step. Expect: each step slides 60 points with a fade both ways; leaving the welcome crossfades the backdrop; each step ticks and the last gives a success haptic; the keyboard goes down between steps.
- [ ] On the sync step. Expect: a Mac window with a QR code and a phone scanning it, not a symbol. Tap Connect to Your Mac. **iPhone:** Settings opens on its Connect to Your Mac page, the same flow as Settings › Sync With Mac; closing Settings returns to the step. **Android:** the connect screen slides up from the bottom; Cancel slides it down. Connect: the phone in the picture turns plum, its viewfinder shrinks away as a checkmark grows in, and the subtitle crossfades from "Your Mac’s tabs, right here. End-to-end encrypted." to "Your Mac’s tabs are here, end-to-end encrypted."
- [ ] **Android:** on the welcome, tap Continue at once. Expect: the default-browser step still shows.
- [ ] **Android:** mid-onboarding, change the system font size so the activity is recreated (step 44). Expect: the same step comes back.
- [ ] **iPhone:** the default-browser step. Expect: it shows only when SwiftUI's would (offered, and not asked within 100 days); with the entitlement off (`--no-default-browser`), it never shows.
- [ ] At the largest text size. Expect: each step scrolls. With Reduce Motion on: the welcome fades instead of moving.

**3. Start page and the search tray**
- [ ] With no tabs and sync on. Expect: the start page's leading button is Spaces; the logo fades and grows from 0.92 and the bar fades as the tray comes and goes.
- [ ] Open the tray. Expect: it comes up with the keyboard and sits on its top edge on every frame, with no gap or overlap (including over Android's navigation bar); with a hardware keyboard it lands after 220 ms; the dim fades in over 200 ms; with Reduce Motion it fades instead of moving. Close it: the keyboard goes and the tray follows it down.
- [ ] Drag the tray down from the field, the incognito caption or the empty area. Expect: the dim lightens; past 8 points the keyboard goes down while the tray holds still; a short slow drag springs back and the keyboard returns; a long drag or a flick closes it.
- [ ] Touch a row, slide along the rows and lift. Expect: the touched row lights at once, each row ticks as you pass it, and the last one opens on release with a confirm tick; the arrow on a query row refines; a 400 ms hold opens the row's menu; past 1.5x text size the list scrolls instead.
- [ ] Type "otter", then "!w otter", then "12*12". Expect: nine rows with an "otter" search kept second; "Search Wikipedia" for the bang; "= 144", which copies with a "Copied 144" toast on a tap and offers Copy on a long press. A Mac tab row shows a laptop and its host and opens as a synced tab.
- [ ] **Android:** inline completion (step 42). **iPhone:** type "goo". Expect: "gle.com" highlighted after the caret; Backspace removes only the highlight; Return opens google.com; with a Japanese or Chinese keyboard no highlight appears.
- [ ] Type a word with more suggestions than fit. Expect: the next row peeks faded at the keyboard's edge; slide from the first row down onto the keyboard and lift: the row laid out there opens, with a tick per row on the way. (The peek and the slide are seen on Android; the ticks, and the slide on an iPhone, are not.)
- [ ] Watch the tray as you type and clear. Expect: the caption, rows and empty tray crossfade; the Incognito label fades and grows from 0.9 at the toggle's edge; the field's text grows with the text size; past 1.5x rows wrap.
- [ ] Copy a link, open the tray; copy plain text, open it again. Expect: "Link You Copied", then "Text You Copied".
- [ ] **iPhone:** with a link copied, open the tray. Expect: Paste and Go with no paste prompt; tap it: iOS asks to Allow Paste, Allow opens the link. Tap it again and refuse: the row goes and nothing opens.
- [ ] **Android:** add Ardia's three Quick Settings tiles and tap each, also on a locked phone. Expect: Search opens the tray, Voice Search the voice screen, Incognito Tab an Incognito tray; a locked phone asks to unlock first.
- [ ] Tap the incognito chip. Expect: what Compose's `IncognitoChip` does on Android; on iPhone a one-item menu, as SwiftUI shows.
- [ ] With TalkBack or VoiceOver on, move to a row's refine arrow. Expect: reachable, read as "Refine" and the row's title; each row's menu items are listed as actions; Close Search can be activated.
- [ ] Tap the mic in the tray, then Cancel. Expect: the keyboard goes down over the voice screen and comes back on the tray. **iPhone:** allow speech and the microphone and say "otters": the words appear as you speak and the search runs; say nothing: after a few seconds it says it didn't hear anything. Watch the voice screen: the transcript crossfades as words arrive, the logo has a soft shadow, on iPhone the waveform eases.
- [ ] Select text in another app and choose Search in Ardia, and run a web search into Ardia (Android steps 4 and 5). Expect: results open at once. Open the voice shortcut: the voice screen opens over the tray. Open a tab widget's link to an archived tab: it is restored; to a private tab: nothing happens. **iPhone:** share a page to Ardia from Safari: it opens in a new tab, as shared.

**4. A page**
- [ ] **iPhone:** on a page with history, drag right from the middle. Expect: the previous page slides in with a tick under your thumb as it commits; a short drag springs back with no tick; a drag on a sideways carousel scrolls it and doesn't go back. (Android: steps 21, 29 and 35.)
- [ ] **iPhone:** at the top of a page, pull down past the spinner. Expect: a light tick, the spinner turns, the page reloads.
- [ ] Scroll a long page. Expect: the bar collapses with Compose's `Motion.barCollapse` spring and travel on Android (on iPhone, main's host pill replaces this). On a page whose colour changes as it scrolls: the bar's colour follows within a quarter of a second.
- [ ] Open the page menu, then drag its sheet down. Expect: it follows the finger and the dim lightens; a short drag springs back; a long drag or a flick closes it; with Reduce Motion it fades.
- [ ] **Android (Material You off):** open the page menu. Expect: it opens at half the screen's height with a drag handle, as the iPhone's system sheet does; the rows don't scroll until it is full; a drag or flick up takes it to full and its rows then scroll; a drag down from the top of the rows lands on half, and another drag down closes it. With TalkBack on it opens at full height.
- [ ] From the page menu: pin to the Mac, Find, Reader, Copy Link. Expect: bottom-bar buttons and a landed tab swipe give haptics; **iPhone:** pinning gives a success haptic and the title's message lasts 1 s and crossfades; the title moves under the buttons at accessibility sizes; Find opens 350 ms after the menu closes and the bar slides away under the find bar. A link's Copy Link says "Copied Link Without Trackers".
- [ ] Open Reader. Expect: text can be selected, a size change animates, and a lead image that isn't a web address is skipped.
- [ ] Open the page menu, Reader and a long-press menu in turn. Expect: the status-bar icons stay readable over each.
- [ ] Long-press a link. **iPhone:** the system menu shows Open in New Tab, Open in Background, Copy Link, Share and Download Linked File; Open in Background leaves you on the page; Share isn't offered while a sheet is open. **Android:** the app's drawn menu.
- [ ] **iPhone:** turn on Desktop Site. Expect: the page reloads as desktop, as SwiftUI's `toggleDesktopSite` does.
- [ ] **iPhone:** allow, then refuse, a site's camera, microphone and location requests. Expect: Allow and Don't Allow reach the page; the answers last until the app is relaunched (saving them waits on Site Settings, "The iPhone redesign" item 13).
- [ ] **iPhone:** a file input. Expect: WebKit's own picker, and Take Photo works. **Android:** steps 13 and 14.
- [ ] **iPhone:** play a video full screen. Expect: it covers the bottom bar and hides the status bar and the home indicator.
- [ ] A site asks to send notifications; start a download. Expect: on Android the request and the download notification as Compose's `PageRequests.kt` show them.
- [ ] Turn on Airplane Mode and open a page; turn it off. Expect: the offline page with a Wi-Fi-off icon, then a reload by itself (Android: step 36).
- [ ] Load a page that fails, then Try Again. Expect: the failure view's icon, title and Try Again as Compose's `PageLoadFailure.kt`.
- [ ] With Android's touch feedback off, use the deck and the bar. Expect: no haptics. On: the deck ticks per card while scrolling, a flick-close taps, Close All's confirm presses. iPhone keeps its impacts.
- [ ] Scroll a long page, kill the app and relaunch; also leave it in the background until the page is discarded, then come back. Expect: the same tab at the same offset both times.

**5. The deck and the tab pager**
- [ ] Scroll a page, then open the deck at once. Expect: the card shows the page as it is now.
- [ ] Hold a card for 400 ms; drag one slowly upward; tap a card right after a scroll settles. Expect: the hold opens its menu without scrolling, the slow drag lifts the card, the tap opens the card under the finger.
- [ ] Press Back in the deck. Expect: the selected tab opens with the expand animation. The card menu lists Send to each device and Pin to Mac; a lifted card can't be tapped open; a deck of 40 tabs scrolls without stutter.
- [ ] Open the deck from the start page. Expect: cards fade in; the backdrop and bar fade with the open; pictures fade in; two pages of one site share a placeholder colour; cards have the native shadow; a tab sent from the Mac shows "From Your Mac" until opened; the archive card scales in. With Reduce Motion: cards close, open and settle without springs.
- [ ] Long-press the bottom bar's tab button. Expect: the recent-tabs menu with Compose's haptic.
- [ ] Swipe the bar between tabs, and flick again while it settles. Expect: the incoming card has an edge shadow; the second flick neither jumps nor switches twice; with Reduce Motion the pager settles without a spring.
- [ ] **Android:** swipe slowly between tabs in a coloured space, light and dark. Expect: the space's colour shows between the pages, never black.
- [ ] **Android:** on a page, swipe up from the bottom bar slowly, then let go short of about 90 dp; again past it; then a short fast flick. Expect: the live page follows the finger, shrinking toward its own card in the deck with the other cards waiting behind it; the short swipe springs back with the page, its scroll and the bar as they were; the long swipe and the flick land the page in its card with the header and the other cards coming in, then the deck's bar takes over without a jump; the card is centred.
- [ ] **Android:** tap a card. Expect: it grows back into the page, the page takes over once laid out, and the bar cross-fades back.
- [ ] **Android:** start a swipe up and press Back, or pull the notification shade down, mid-swipe; also press Back just after letting a swipe go past its commit. Expect: the cancelled swipe springs back and never opens the deck; Back after the commit does nothing until the deck shows, and never takes the page back a step.
- [ ] **Android:** with Remove Animations on, swipe up and tap the tabs button. Expect: the page cross-fades into its card without following the finger, and a card fades back into its page.
- [ ] **Android:** in landscape, swipe up on the bar; with TalkBack on, open the deck from the Tabs button. Expect: the page lands on the landscape card; TalkBack never reaches the waiting deck under a page, and reads the deck once it shows.
- [ ] **Android:** with gesture navigation and then 3-button navigation, open the deck and the start page from a page, then focus Search Tabs. Expect: the deck's and the start page's bars sit exactly where the browsing bar does, clear of the gesture handle, and don't move during a swipe up; with the keyboard up, Search Tabs sits 8 dp above the keyboard with no extra gap for the navigation bar.
- [ ] **Android:** open the deck with more tabs than the archive offer needs; close it and open it again; then dismiss the capsule. Expect: the capsule on every open until dismissed, then never again; picking an interval also retires it.
- [ ] **iPhone:** with VoiceOver on, swipe up or down on a card. Expect: it moves between tabs; the Tabs button answers a double tap.
- [ ] **iPhone:** press the deck bar's three buttons. Expect: they light up and flex under the finger as SwiftUI's do; with Reduce Transparency on, they turn white with an edge.
- [ ] **iPhone:** the deck's animated backdrop, frosted controls and glass bar on a device, with Reduce Motion and Reduce Transparency switched on and off. Expect: each switches as SwiftUI's does.

**6. The Archive**
- [ ] Open the Archive with tabs archived over a week. Expect: headers read Today, Yesterday, a weekday within six days, then the date (the year only when it differs), pinned with a tinted background; rows show a plain favicon; restoring ticks; Delete All warns and is disabled when empty; a search with no results shows the magnifier; an empty Archive shows its tile even while searching; Android Back clears a search first; on iPhone a swipe reveals Delete rather than deleting.
- [ ] Leave a tab longer than the archive interval with the app open. Expect: it is archived within 15 minutes.

**7. Sync and Spaces**
- [ ] **iPhone:** leave the app for an hour with the Mac open, then open it. Expect: the Mac's tabs are current without waiting.
- [ ] Send a tab from the Mac. Expect: a toast names it for about two seconds on both phones, and tapping it opens the tab.
- [ ] Settings › Sync › Connect to Your Mac › Scan Code, at the Mac's code. Expect: the scanner covers the whole screen with four corner arms; "Not an Ardia sync code." fades in for a wrong code; Cancel and Android's Back stop the camera; the status bar reads. **iPhone:** the code is outlined when found, pinch zooms, and it connects without typing. (Android: steps 19 and 28.)
- [ ] Enter Recovery Phrase (the scanner's button says the same). Expect: it slides in from the right over the connect page; the counter and footer crossfade as you type; on iPhone the keyboard is ASCII and a drag on the list dismisses it. **iPhone:** copy the phrase on the Mac and tap Paste: the words fill in with no "Allow Paste" question; Add a List does the same with an address.
- [ ] Open Spaces with the Mac connected. Expect: pinned tabs show their symbols; what you open or expand is kept when you come back; new rows fade in; the header crossfades; at 1.5x text size tab icons grow, titles take three lines and tiles drop their titles; a long press offers its menu to TalkBack and VoiceOver. With sync off, the empty state opens Connect. **iPhone:** the banner icons are the system's.
- [ ] Open a Spaces row, then type its host in the tray. Expect: it is offered as a visit you typed (`AppModel.kt` `openRemote`).
- [ ] While Spaces is connecting, drag its sheet down. Expect: it doesn't close.
- [ ] Turn Match My Mac off while the Mac has a custom theme. Expect: the colour Compose's `choiceAfterMatchToggle` keeps.

**8. Settings**
- [ ] Toggle Site Settings and filter-list switches quickly. Expect: no switch snaps back for a moment.
- [ ] **iPhone:** Clear Browsing Data from Settings. Expect: the "Cleared" toast shows above the sheet. Sign in to a site, use the phone for a day, then clear Last Hour with Cookies and Site Data on: you are still signed in.
- [ ] **iPhone:** Restore Defaults and Remove List. Expect: today centred dialogs; action sheets once the native menus land ("Decided by the owner").
- [ ] **iPhone:** tap About's links and a filter list's link. Expect: they open where SwiftUI's `Link` opens them.
- [ ] **iPhone:** once the build carries the web-browser entitlement, Settings › Default Browser › Open Default Apps. Expect: the system's Default Apps page; choose Ardia and come back: the page says Ardia is your default browser.

**9. Toasts**
- [ ] Raise a toast, hold it, then drag or flick it down; raise the same one twice; raise one with the keyboard up. Expect: it slides up from slightly smaller and slides down as it leaves; a finger holds it; a drag or flick down dismisses it; a short drag springs back and it leaves 1.2 s later; the same toast doesn't replay; with the keyboard up it sits at the top; VoiceOver reads it; a tab from an iPhone shows a phone.

**10. Outside the app (iPhone; Android's are steps 1 to 18 and 31)**
- [ ] With a page open, look at the Mac's Dock. Expect: a Handoff icon offers the same page; private tabs never offer one.
- [ ] Say "Open Otter in Ardia" for an open tab; add Shortcuts' Open Tab action and run it. Expect: Ardia switches to the tab; the action lists your tabs with their sites.
- [ ] In Spotlight, type a word from an open tab's title and tap the result; do the same for an archived tab. Expect: Ardia opens that tab; the archived one comes back from the Archive.
- [ ] Touch and hold the app icon. Expect: Search, Voice Search and New Incognito Tab each open what they say.
- [ ] Add a Lock Screen widget and a Control Center control, and the search widget. Expect: each opens the right link; the search widget follows the profile colour and Match My Mac.

**11. Lab builds only**
- [ ] Launch with `ArdiaDemo`, then each `Browse…` and `Ardia…` argument in "Launch arguments on Android" and "Launch arguments on iPhone" below (Android: step 41). Expect: eight demo tabs with Sintra selected, nothing written to the real store, the demo Macs in Spaces; each argument does what it does in the native apps at the same delays (6 s browse delay, 600 ms sheet, 1.5 s toast, 3 s deck open, 1.2 s deck script start); `ArdiaDeck` steps play in order; the pager freeze and script hold and swipe as Compose's do.

Not audited at all: Compose's `SyncSetupContent` internals inside onboarding.

### Deliberately different

- The swipe into the deck is aimed at the page's own card, where Safari's page stays centred (the owner's review of
  the first build, 2026-11-18: the page must not shrink past its card and grow back).
  - **Safari:** during the pull the page stays centred and shrinks to about 56% of the screen; on release it grows
    into its tile and moves there.
  - **Ardia:** the page's frame goes from the full screen toward its card's frame as the finger travels, so in the
    stack it moves right as it shrinks, and it is never smaller than the card.
  - **Kept from Safari:** only the page shows during the pull, over the deck's backdrop; the other cards and the tab
    view's controls come in at release; the commit distance; the return.

- The new-tab search panel (build 19, the owner: "decrease the height of the url bar", "it should continue to bottom
  not be cut around keyboard", "the roundedness is weird around the url bar", "better to have the eyes icon in the
  url bar and be clickable"):
  - **Field:** the standard 47.5 pt Search field at the standard size, where it was a 56 pt field in 22 pt type.
  - **Incognito:** the address bar's thin specs (`eyeglassesThin`, 26 pt) inside the field, after the mic, and a tap
    on it switches Incognito, as the field does when editing a page's address. The 44 pt circle beside the field is
    gone. Main draws SF `eyeglasses` at 17 semibold here.
  - **Under the keyboard:** the panel's card runs on behind the keyboard to 8 pt above the screen's bottom
    (`trayPanel` sits the keyboard's lift below the screen and the stage lifts it back); its rows still end 8 pt above
    the keyboard. Both a new search and editing a page's address use this Arc panel, at the fixed Arc height (the
    field plus four rows), with the current page as the first row when editing its address: the owner's later
    decision in #3118 (89c839bacf), which replaced the shorter panel that used to float above the keyboard when
    editing an address.
  - **Placement:** one rule in `searchPanelTokens.ts` (`searchPanelPlacement`, `searchPanelPlace`) picks one of three
    modes. `underKeyboard` is the phone layout's Arc panel above: top corners only, the card running on under the
    keyboard. `aboveKeyboard` is a card rounded on all four corners, inset from the sides and floating above the
    keyboard, only as tall as its rows up to the Arc height; the half-open Duo's `split` layout uses it, and so does
    the React Native fallback tray in any look other than the redesign. `commandBar` is the wide layout's command bar
    under the card's top (open Duo).
  - **Height:** derived, not fixed in points: `searchPanelHeight` is the field inset, the field, the gap above the
    rows, four row pitches scaled with the text size, and the bottom inset; a floating panel takes the smaller of that
    and the field block plus its rows' measured height (`searchPanelPreferredHeight`).
  - **Corners:** every search panel's corners are concentric with the field's capsule: the field inset plus half the
    field's height (`searchPanelRadius` in `searchPanelTokens.ts`, so it grows with the field under Dynamic Type),
    passed to the native morph as `panelRadius` and used by the wide layout's command bar too; they were 26, tighter
    than the field's own curve allowed.
  - **To watch:** `new_tab_search_opened` should hold its level after the release.

- Settings, Archive, History and Bookmarks keep one neutral background, the system's grouped background, whatever
  space is shown (build 19, the owner: "as different spaces have different bg we shouldn't carry that everywhere").
  - **Main** tints every one of these pages with the shown space's window tint, so Settings changed colour with the
    space behind it.
  - **Ardia:** the space's colour stays where the space is: the start page, the deck and the Spaces sheet. The
    Appearance row's icon still takes the chosen colour, and the colour picker is unchanged.
  - **Where:** `SettingsChrome` in ArdiaDesign's `SettingsPieces.swift`, which every Expo UI settings page, the Archive
    and the library pages apply.

- A page that isn't secure shows a red open lock in the bar, not the words "Not Secure" (the owner's decision,
  16 Nov 2026: "we can show open lock with red i guess see the arc for that").
  - **Where:** the redesigned bar's address capsule, the collapsed host pill, and the Duo toolbar. The lock
    takes the site icon's slot at the site icon's size, so the address starts at the same x on a secure and an
    insecure page, and the stage's face snapshot and the landed pill carry it.
  - **Glyph:** SF `lock.open.fill` on iPhone; on Android a drawn glyph in Material's `lock_open` shape (filled body
    with a keyhole, the shackle open on the left). Colour: the destructive red token, `#FF3B30` light and `#FF453A`
    dark, replacing the bar's orange.
  - **Words kept:** the address's accessibility label still says "Address, Not Secure" and the pill's value says
    "Not Secure, <host>". Every place a tap explains a page's security keeps its text.
  - **Main** shows the words (`BarControls.swift`). Arc's own indicator hasn't been measured here; the capture from
    Arc Search on the F4 decides whether shape, size, colour or position change.

- Collapse Bottom Bar on Android is enabled when no valid saved choice exists. Explicit on and off values,
  including imported values, win. iPhone keeps its existing default and spring. Android keeps the 30 dp host pill
  mounted but hidden from touch and accessibility while expanded. Collapse and expand run iPhone's fold on
  iPhone's spring (0.26 s, no bounce): the bar shrinks to 62 % into the pill as the pill grows out of it, and the
  pill's surface fades with it, since Android has no glass to fade. On Android the bar and the pill cast no shadow:
  inside the folds' hardware layers a shadow was cut flat at the pill's edges, and without the layers the shadows laid
  a grey strip the bar's height across the page (POCO F4, 2026-11-20). Remove animations snaps to the endpoint. The page's
  direction update no longer waits for a second effect to choose the toolbar state. Tapping the pill expands it;
  the next upward then downward scroll can collapse it again. The deck keeps its own motion settings.
  Watch the consent-gated `usage_counts.bottom_bar_collapses` count, never recorded in Incognito; on iPhone it
  counts only the open Duo's squeeze. This measures
  collapse use, not frame smoothness. Smoothness and viewport resize counts still need real-device captures.

- The page under the bar (the owner's decision, 2026-11-16, revised 2026-11-22).
  - **iPhone:** the page runs full screen under the glass bar, and WebKit gets the covered edges as
    `obscuredContentInsets`, so fixed footers and the page's last lines stay above the bar.
  - **Android, with Collapse Bottom Bar on (the default):** the page runs full screen under the bar and the host
    pill, as on iPhone, with no fade over it (the owner, 2026-11-22: iPhone keeps its fade). The page is never resized while
    scrolling, so no flat band shows behind the pill. Android's WebView has no obscured-insets equivalent (only
    `viewport-fit=cover` pages on WebView 140 and later get `env(safe-area-inset-*)`), so a fixed footer sits
    under the bar until a scroll down folds it to the pill, and the page's last lines sit under the pill's base.
    The owner chose that over the band on 2026-11-22.
  - **Android, with Collapse Bottom Bar off:** the bar never moves, so the page stops at its top and the band
    under it takes the page's bottom tone; otherwise the page's end could never scroll clear of it.
  - **One shape in JavaScript:** `pageObscuresInsets()` is true on both, and the bar code passes the same
    `obscuredInsets` and `toneInsets` on both (`obscuredBottom` in `lib/barCollapse.ts`). It also passes
    `obscuredColors`, the colours its own bars use: the page's remembered tone, or the theme's surface before it
    has one.
  - **What Android's page view does with them** (`PageView`, `PageBands`):
    - it lays the WebView out between the bands and paints the bands in those colours;
    - it samples the tone at the WebView's own edge;
    - it composes deck snapshots with the bands, so a card is the page as shown.
  - **The tone under the bars on Android** (2026-11-22): each sampled edge also keeps its strip's commonest colour,
    even when text or images keep any one colour from a third of it (`ToneSampler.shade`). The theme colour, the
    page's background colour and earlier samples are used only when they are on the same side of dark as that
    shade, so a site that declares a light `theme-color` but draws dark (Wikipedia at night) gets dark bars and a dark
    fade. An edge the latest sample can't tell keeps the last one sampled on the same document. iPhone still puts the
    theme colour first at the top.
  - **Revisit** if Android's WebView gains an equivalent of `obscuredContentInsets`: then hand it the bar's height
    as iPhone does, so fixed footers and the page's end clear the bar too.
- Long press on links and images in a page: iPhone shows WebKit's system menu with Open in New Tab, Open in Background, Copy Link, Share and Download Linked File (the SwiftUI app says Share…; Share has no ellipsis anywhere in the Expo app); Android shows the app's drawn menu from `page.longPress` (c317c5b8f).
- Voice screen status-bar icons: always light; Compose takes them from the light-mode tint although the screen is always dark (3a9ca2f10, `lib/statusInk.ts`).
- A link's `download="name"`: iPhone saves under WebKit's `suggestedFilename` as given (`DownloadManager.destination`), which WebKit fills from the response's Content-Disposition or the link's `download` attribute; Android names a download from its URL (`DownloadRules.linkName`, `URLUtil.guessFileName`) and, for a link with no type or disposition, from the response, as Download Linked File does, and reads no `download` attribute. A known gap, not to be added on Android without a decision (`SystemDownloadsTest`).
- Pin to Mac from the page menu: Android keeps Compose's toast, iPhone answers in the menu's title as SwiftUI does (5023ecabd).
- Paste and Go: on both. iPhone checks the pasteboard with `hasStrings`, `hasURLs` and `detectPatterns`, which show no paste prompt, and reads it only when the row is tapped (`PhoneClipboardModule.swift`); a refused prompt drops the row.
- Wording: each phone keeps its native app's words through one copy table per platform (`lib/platformCopy.ts`, 5db9a2263).
- On iPhone, Settings, the Archive and Spaces are toolkit screens in the system's own sheet (Expo UI's BottomSheet), as main's SwiftUI app shows them; on Android they share one drawn sheet, as Compose's `SheetHost` (3a9ca2f10). Bookmarks live in the Library sheet with History and Downloads, as main's do; Spaces shows none, as main's doesn't.
- On iPhone, menus are the system's own: `components/ui/MenuTrigger.tsx` shows UIKit's context menu (`ContextMenuView`, by tap or long press) and action sheet (`confirmInSheet`), with each call site's items and order taken from main's SwiftUI app; the toolkit screens use Expo UI's Menu and ContextMenu. Android has no system menus in the app: the same items open in the drawn menu (`components/ui/Menu.tsx`, submenus as a second page with a back row) and confirmations in the drawn action sheet (`components/ui/ActionSheet.tsx`), both made to the iPhone's measurements. A long press opens the menu at the finger, as Android's own menus do, where UIKit lifts the pressed view.
- Backdrops: native look views where the module has them, CSS gradients elsewhere; no Skia (the owner's decision).
- The code scanner is the module's own view (`ScanView`); expo-camera and its ML Kit are gone (00b9064e9).
- A suggestion whose text is an address opens that address, so a row tap does what Enter does (87bc6e89f).
- On iPhone a long address in the search field scrolls with a sideways swipe, selection and handles moving with it (`CompletingTextField`'s pan; `address_field_scrolled` counts it). Main's SwiftUI field, like Safari's, only scrolls by moving the cursor. A swipe that starts on the cursor or a selection handle still moves that; a mostly vertical one still pulls the panel down. Android's field already scrolls under the finger.
- A link that arrives during onboarding is held and only the last one runs afterwards (43753d1b5); both apps act at once.
- The deck bar sits 6 points above a three-button navigation bar instead of on it (2db78f033), placed from the screen the deck covers (22016d607); gesture navigation keeps Compose's numbers. The owner kept this on 2026-11-15: overlapping the system's buttons is worse.
- Find on Page is the app's own bar on Android; iPhone uses WebKit's find panel as SwiftUI does.
- Opt-in usage stats (Settings, What's Sent, onboarding's last step) exist only in the Expo app (c6ebf08a8, the owner's approval).
- Settings has no Appearance or Downloads rows because Compose has neither (f5d1ec9f2). On iPhone this is stale: main's SwiftUI has both ("The iPhone redesign", items 7 and 11).
- Toasts sit above the deck bar's measured top, not a fixed 64 dp, so they never cover + (87e9ed9e6).
- After a reload the failure screen stays until that load ends, so the WebView's own error page never shows (becf40624).
- Labs and the sync demo are gated by the build (`ARDIA_LAB`, `ARDIA_TEST_BUILD`), not by a debuggable build as in Compose (4f474ff95).
- The Sync page's inbox-problem notice exists only in the Expo app (d9b85412f).
- Licences are generated from the shipped code, not a hand-written list (aa44da003); the iPhone list's content is the gap above.
- The sync demo keeps its tabs in memory (the owner's decision, "Decided by the owner"); Reset › Connect Again acknowledging the reset first and Bookmarks in iPhone Spaces (253515009) are the owner's choices, in "Waiting on the owner".
- The tray's rows end at the last whole row and don't scroll at normal text sizes, so no partial row is drawn for a fade mask (992441306, 7287c72fd); both apps clip with a fade instead.
- Matches both apps, not a gap: a cold start opens on the start page, never on the last page, and with Auto-Open Keyboard on raises the launch tray there, with the start page's logo and bar faded out behind it. Compose and SwiftUI both start on `Surface.Search`/`.search` and raise the tray when the start page appears (`SearchHomeView.kt` `openTrayIfWanted`, `SearchHomeView.swift`'s `.task`); neither brings back the page after a kill or a long absence. On Android the launch tray is at rest from the app's first frame and the keyboard lifts it when it comes, with the start page's bar drawn under it (0716fff91): it used to wait up to 450 ms for the keyboard, unseen, while its backdrop caught taps and closed it onto the last page (the F4's "dropped" taps at 674 to 971 ms and its launches that landed on the page, 16 Nov 2026). Back then closes the tray onto the selected tab's page, as Compose's `cancelSearch` (M3 sync12 item 6, checked 2026-11-15).
- Matches Compose, not a gap: with the on-screen keyboard up, the first Back only drops the keyboard and the tray stays, with the start page's logo hidden behind it, because the keyboard takes that Back in both apps (F4 sync12, the owner's call on 2026-11-15).

## Build and run

```
scripts/agent/locked pod -- pnpm install             once, from the repo root
apps/phone/scripts/gradle-locked :app:assembleRelease   JS bundled in, app/build/outputs/apk/release/app-release.apk
apps/phone/scripts/gradle-locked :app:assembleDebug     loads JS from Metro
pnpm -C apps/phone dev                               Metro on :8091 (the Mac's Metro keeps :8081); adb reverse tcp:8091 tcp:8091
pnpm -C apps/phone typecheck
```

Needs JDK 17 and the Android SDK (`local.properties` or `ANDROID_HOME`). The first build compiles React Native's and
Expo's Gradle plugins and the C++ of every native module, about 15 minutes on a busy Mac; JS-only changes rebuild the
release APK in about 2.

### Building Android on corex

Android APKs for phone runs are built on corex, not on the Mac, and so are the Kotlin unit tests. The Mac's disk
and load are for the iPhone builds, and the phones are on corex.

**Never start Gradle on the Mac, not even for the unit tests.** One unit-test compile there regenerates several
gigabytes of `~/.gradle/caches/9.4.1/transforms` and leaves a daemon holding memory. On 2026-11-16 the Mac fell to
3.7 GB free, the level at which every session crashed on 2026-11-14. The one exception is the upgrade pair signed with
the Compose app's key (`build-apk --compose-key`), built rarely and with `ARDIA_GRADLE_EPHEMERAL=1`, so Gradle runs
with `--no-daemon`.

```
apps/phone/scripts/corex-build <name> <commit> [build-apk options]   an APK, in corex's bots container
apps/phone/scripts/corex-test <commit> [--patch FILE] [--tests filters]   the Kotlin unit tests, the same way
```

- **`corex-test`** runs `:ardia-phone-native:testDebugUnitTest` in the same build-only clone, at a pushed commit.
  - `--patch` applies a diff from the main checkout (`git diff HEAD -- <your files>`) for that run only; the clone is
    reset when it ends.
  - It prints each test class's count and every failure.
  - It and `corex-build` hold the clone's lock, so a build and a test never share it, and both wait for another
    Gradle run.

- **Where it runs.** In the `bots` container (14 GB); it refuses `dev`, which holds the owner's T3. It waits while
  another Gradle build runs there or less than 8 GB is free, and never moves to `dev`. One Android build at a time:
  the Gradle lock, as on the Mac.
- **What it builds.** A pushed commit on `t3/unify-expo-architecture`. `~/Developer/ardia-android-build/src` is a
  build-only clone: every build fetches, detaches it at the commit, resets and cleans it (only the build outputs Git
  ignores stay).
  - **Never edit, commit or push there.** All work happens in the main checkout; the folder's README says so.
  - The scripts come from the branch head (`tools/`), so an older commit builds with today's `build-apk`.
- **The same `build-apk`.** It runs with `ARDIA_BUILD_ROOT` at the clone, so the stamp, the dirty check and
  `check-names.py` are unchanged. Gradle runs without a daemon and Kotlin in-process, so nothing stays resident on
  the shared machine.
  - The signer is the committed `apps/phone/android/app/debug.keystore`, the same as on the Mac, so a corex APK
    installs over a Mac one.
  - `--compose-key` (the upgrade pair, signed with the Compose app's key) is built on the Mac only.
- **Output.** `~/Developer/ardia-phone-apks/<name>.apk`, with `<name>.txt` (the stamp, plus a `built on:` line
  with the install and build times) and `<name>-r8/`. The newest 8 builds are kept.
  - Phone runs on corex read them there: no `scp` from the Mac for Android.
  - The Compose app's release build, the reference in every run, is `reference/ardia-compose-release.{apk,txt}`
    (signer `eeb05c92…`); pruning never touches `reference/`.
- **The tools it adds, beside the clone, not in the shared SDK:** `pnpm-<version>/` (the version `packageManager`
  pins, first on the path, since `bundle-export` runs pnpm too) and `sdk-view/`. `sdk-view/` is cmdline-tools 23.0,
  pinned by checksum, which `check-names.py` needs for `apkanalyzer`; it must sit in an SDK layout, so the view links
  the shared SDK's other parts. Bundle exports go to `tmp/` there, so their offline install finds pnpm's store on the
  same filesystem.
- **Starting it.** From the Mac, or from a corex thread through `ssh corex`:

  ```
  ssh corex bash -s <<'EOF'
  docker exec -i bots bash -lc 'b=$HOME/Developer/ardia-android-build; mkdir -p $b; [ -d $b/src/.git ] || git clone -q --no-checkout https://github.com/ardia-browser/ardia.git $b/src; git -C $b/src fetch -q origin t3/unify-expo-architecture; git -C $b/src show FETCH_HEAD:apps/phone/scripts/corex-build > $b/corex-build.run; bash $b/corex-build.run <name> <commit>'
  EOF
  ```

- **Checked against the Mac (2026-11-16, 25c45496a).** The corex build and the Mac's expo58m have the same commit
  stamp, the same signer and the same JS bundle bytes; 2,175 of 2,192 files are identical.
  - **Native libraries:** each differs by the length of the checkout path compiled in (184 bytes); so do the two
    Hermes sync files (21 bytes).
  - **The dex:** differs in R8's map id. `classes.dex` also differs in 18 Compose functions from the Compose app's
    widget and settings sources, where the Mac checks one parameter's stability at runtime. Corex's clean and
    incremental builds are identical in every file, which points to the Mac's incremental history (unproven).
  - **On the F4,** the corex APK installed over the Mac one as an update, kept the app's data and ran.
  - **Build times:** the first full build took about 11 min 20 s, an incremental one 107 s.
- **Toolchain on corex.** JDK 17.0.21, NDK 27.1.12297006, build-tools 37.0.0 and android-37.0 are in the containers'
  `~/Android/Sdk`. The Linux `hermesc` is pinned by hash in `packages/phone/android/build.gradle`. pnpm 12.21.0 comes
  from `packageManager`.

### Android release

Decided by the owner (2026-11-16): Android ships as an APK on GitHub Releases, with no Play listing. Nothing is
published without the owner's OK. iPhone's counterpart is "The Expo app on TestFlight" below.

**Which build goes public first.** Not the Android of today. The APK goes public with the release that follows the Expo
work being finished, iPhone and Android together. On Android that means the redesign switched on, the release checks
passing, and a phone pass on the candidate. Until then the workflow and the candidates are rehearsals.

Parked on 2026-11-17, when the owner rejected the redesign on Android, and taken up again on 2026-11-19 with drawn
menus ("Decided by the owner (2026-11-19)"): a candidate follows a phone pass of that build.

**The workflow.** `.github/workflows/android-release.yml`, dispatch-only. It reaches `main` with the Expo branch's own
pull request (#1556, which also closes #2160), and can't be dispatched before that merge. Then the commands are:

```
gh workflow run android-release.yml -f mode=dry-run [-f commit=<sha>] [-f version=0.2.47-nightly.2]
gh workflow run android-release.yml -f mode=draft -f commit=<sha> -f version=<release version>
gh run watch --exit-status                                     the run's summary has the stamp and every check
```

- **What a run does.** It builds the shrunk arm64 APK on `ubuntu-latest` with `build-apk --store` from the commit's
  export, so the lab is off and `ardia_sync_offered` is false. Then it runs `sign-release-apk.test.sh`, signs the APK
  with the release key through `apps/phone/scripts/sign-release-apk`, and runs `check-release-apk`.
  - **dry-run** keeps `Ardia-<version>.apk`, its `.txt` stamp and `.sha256` as a workflow artifact for 14 days.
  - **draft** attaches the same three files to a new draft prerelease `android-v<version>`.
  - Neither publishes, and neither marks a release as latest.
- **The release key.** It lives only in the repository secrets: `ANDROID_RELEASE_KEYSTORE_B64` (PKCS12),
  `ANDROID_RELEASE_KEYSTORE_PASSWORD` and `ANDROID_RELEASE_KEY_ALIAS`. Its certificate's SHA-256 is pinned in the
  workflow: `8A:B5:0E:90:…:41:98:BC`.
  - `sign-release-apk` decodes the keystore into a private folder (umask 077) that a trap removes, and the workflow's
    `always()` step checks it's gone.
  - The password reaches `apksigner` as `env:` for both the store and the key. It's never on a command line, and never
    `file:`: given one file for both, apksigner reads the key's password from the file's second line, and the signer
    fails to load.
  - `apps/phone/test/release/sign-release-apk.test.sh` makes a throwaway PKCS12 key and a minimal APK, and runs the
    script. It checks:
    - the signer;
    - that no keystore is left behind;
    - that a wrong password fails;
    - that the password never reaches the output.

    It runs in the workflow before the real signing, and on a Mac without Gradle.
  - It is never on corex. Lab builds keep the repo's debug key.
  - The alias is a secret, so GitHub masks the word "ardia" in that job's logs and summary; the attached stamp file
    isn't masked.
- **Dispatching.** A workflow can only be dispatched once its file is on the default branch, the same as
  `ios-release.yml` for the Expo iPhone app. A run on a commit without the release scripts stops at its first step and
  says so.
- **No gate.** It needs no `gate` job and no `GATED_WORKFLOWS` entry: it has no `pull_request` trigger, so no outside
  author can start it, and dispatching takes write access.

**The checks** (`apps/phone/scripts/check-release-apk`). The run fails if any of these fail:
- the signer equals the pinned fingerprint, and the signature verifies;
- the package is `com.ardia.browser.android`;
- the versionName and versionCode are what `android-version.ts` gives;
- there's no debuggable flag, and the native code is exactly `arm64-v8a`;
- the stamps: the commit, a clean tree, and the JS from the export;
- sync isn't offered, the shell's profiling is off, and the release version is stamped;
- the main window is locked to portrait. Store builds set `screenOrientation` portrait through the manifest placeholder
  `ardiaScreenOrientation`, and lab builds leave it free so landscape work goes on. A full-screen video still turns.
  When landscape ships, the placeholder and `--orientation "free to turn"` change together;
- `check-names.py` passes.

**The version.** One source, no hand edits: the `version` input, or else the Mac app's `MARKETING_VERSION` at that
commit, as `release-ios` takes it.
- `apps/phone/scripts/android-version.ts` turns it into the versionName (the release version itself, e.g.
  `0.2.47-nightly.2`) and the versionCode, by `main`'s release-channel formula (14a4f71f7, `docs/releasing.md` ›
  Every platform): major·10^8 + minor·10^6 + patch·10^3 + the nightly's number, or 999 for a stable. So
  `0.2.47-nightly.2` is 2047002 and `0.2.47` is 2047999. It stops on a major over 20, a minor over 99, a patch over 999,
  or a nightly outside 1–998.
- Every nightly sorts below its stable, each release is above the last, and every release is above the lab builds'
  versionCode 2. A build without a release version is a Dev build: versionName `dev`.
- The candidates before the formula changed (rc1 204702, rc2 204703) are below every release under it, so a release
  updates over them.
- `build-apk --version` passes both to Gradle. `appRelease()` gives the release version, empty for a Dev build. The
  Settings footer should read as `main`'s does: "Ardia 0.2.47 Nightly 2 (2047002)", "Ardia 0.2.47 (2047999)", or
  "Ardia Dev". The JS label shows "Nightly" only for a TestFlight receipt, so this is the screens agent's change.
- The iPhone build of the same release reads "Ardia 0.2.47 Nightly 4 (n)". Its build number counts uploads; Android's
  versionCode comes from the version alone.

**Existing installs.**
- **Outside:** the Compose app was never released, so nobody outside has it installed.
- **The owner's phones:** a Compose build or a lab build there is signed with another key, so the first release key
  build needs that one uninstalled first, losing its local tabs and history.
- **After that:** release builds update over each other, since the key and a rising versionCode are what Android
  checks.

**Why an Android release can't move the Mac's.**
- **The repo's consumers.** Every one that wants the Mac's current release asks for GitHub's "latest": the Sparkle feed
  (`releases/latest/download/appcast.xml`, also behind ardia.dev's nginx), `scripts/lib/releases.sh`'s
  `latest_stable_tag` (used by `publish.sh` and `rollout-everyone.sh`), `release.yml`'s feed checks, the site's
  Releases link and the CLI installer.
- **GitHub never makes a draft or a prerelease "latest".** The repo already shows it: newer `engine-*`,
  `windows-alpha` and `v0.2.47-nightly.*` prereleases and `windows-engine-*` drafts sit above `v0.2.46`, and latest is
  still `v0.2.46`.
- **The Android release is a prerelease from the start.** It stays one when published, so publishing can't make it
  latest either.
- **Consumers that name a tag:** `nightly`, `v<version>`, the engine pins by exact tag. `android-v` matches none of
  their patterns.
- **The dashboard and `scripts/stats/github.mjs`:** they list every release, and take "latest" as the first
  non-prerelease, as they already do past the engine and Windows prereleases. An Android row counts no `.dmg` or
  `.zip`.

**A candidate before the workflow is on main.** The Android agent builds a release-style APK on corex:
`corex-build <name> <commit> --store --version <release version>`, with the lab off and sync not offered. The lead
signs a copy on the owner's Mac with the release key and runs `check-release-apk` on it, then puts it beside the build
as `<name>-release.apk` with its stamp. The key never leaves that Mac. The phone pass runs on that file.
- The first was `rc1-release`: 53e013c78, 0.2.47-nightly.2, 204702, every check passing.
- The second, `rc2-release`, checks an update in place.

**Known in a candidate, not a regression.** Read these before judging a candidate:

| What | Why | Until |
|---|---|---|
| No way into the Library (History, Bookmarks, Downloads) on Android | The old Android design has no entry point. The redesign's page menu has History, Bookmarks and Downloads rows. Seen in rc1-release (F4, 2026-11-16) | Android switches to the redesign |
| Copy Link leaves the page menu open | Compose did the same: its Copy Link tile copies and confirms with a haptic, and only Share dismisses (`PageMenu.kt` at 01a149d87) | deliberate |
| A spoken voice search is untested | The phone lab has no audio path into a phone's microphone (corex has no audio device), so the recognizer is only checked up to its Listening screen and cancel | a person tries it on a phone before a stable release |

**Who presses what.**
1. **The Android agent:** the candidate's build on corex, and the phone pass on the signed file, with the evidence in
   `/tmp/ardia-phone-shots/android-<candidate>/`.
2. **The lead:** signing a candidate with the release key on the owner's Mac.
3. **After #1556 merges, the owner the first time:** the workflow's dry run, then `mode=draft` for the release version.
4. **The owner only:** publishing the draft on GitHub. Keep it a prerelease, and never set it as latest.

### The old Android app, cleaned out

The owner's order (2026-11-16): clean the Compose app out of this branch now, keeping only what the Expo app builds from
and what comparisons need. `main` keeps it until this branch merges. The iPhone agent does the same for `apps/ios`.

**What the Expo app built from `apps/android`** (443 tracked files; 163 compiled by the Expo build). Each was compiled
in place through source sets with file lists, in `packages/phone/android/build.gradle`,
`apps/phone/android/app/build.gradle` and `apps/phone/android/ardia-design/build.gradle`. The clean-up's commits:
- a83ddfb2b pins;
- 0f7aadf43 moves (223 renames);
- 683d4fecb and 6c4cb6e19 paths;
- be0ba4048 deletion (221 files, 31,047 lines);
- the follow-through after them.

Reverting them restores `apps/android`.

| In `apps/android` | What used it | Decision | Now |
|---|---|---|---|
| `browser/src/main/kotlin`, all but `Omnibox.kt` and `PageSurface.kt` | `@ardia/phone-native`: the page engine (WebView pages, downloads, page requests, captures) | keep | `packages/phone/android/src/main/java/com/ardia/{browser,browsing}` |
| `browser/src/main/assets` (night shade, page look, readable content) | the page engine | keep | `packages/phone/android/src/main/assets/ardia-browser` |
| `browser/src/main/res` (strings, capture paths) | the page engine; the phone manifest's capture provider | keep | `packages/phone/android/src/main/res/values/page_engine_strings.xml`, `res/xml` |
| `Omnibox.kt`, `PageSurface.kt`, `browser`'s manifest | the Compose app only; the manifest's provider is already in the phone manifest | delete | |
| `blocking/src/main` (Kotlin and `resources`: filter list catalog, consent script, public suffix list) | `@ardia/phone-native`: content blocking | keep | `packages/phone/android/src/main/java/com/ardia/blocking`, `src/main/resources` |
| `shared/src/main/kotlin` and `cpp/ardia_hermes.cpp` | `@ardia/phone-native`: the script runtime that runs the sync bundle (`-DARDIA_SCRIPT_SHIM`) | keep | `packages/phone/android/src/main/java/com/ardia/shared`, `src/main/cpp` |
| `shared/src/main/cpp/CMakeLists.txt` | nothing: the phone's own `CMakeLists.txt` builds the shim | delete | |
| `sync/src/main` and `sync/src/test` | `@ardia/phone-native`: the sync engine and its unit tests, compiled into `CompileSyncBundle`'s module | keep | `packages/phone/android/src/{main,test}/java/com/ardia/sync` |
| `appmodel`: `SystemLink.kt`, `SystemActions.kt`, `LaunchArguments.kt` | `@ardia/phone-native`: system links, launch arguments | keep | `packages/phone/android/src/main/java/com/ardia/appmodel` |
| `settings`: `SyncCodeReading.kt`, `SyncCodeCamera.kt` | the sync code scanner | keep | `packages/phone/android/src/main/java/com/ardia/settings` |
| `search`: `SpeechRecorder.kt`, `DictationTypes.kt`, `ClipboardOffer.kt`, `CompletingFieldState.kt` and `CompletingFieldStateTest.kt` | voice search, the paste offer, the completing field | keep | `packages/phone/android/src/{main,test}/java/com/ardia/search` |
| `store`: `InlineCompletionEditor.kt` | the completing field | keep | `packages/phone/android/src/main/java/com/ardia/store` |
| `design`: `FaviconPixels.kt` | favicons | keep | `packages/phone/android/src/main/java/com/ardia/design` |
| `design`: the 20 files `ardia-design` listed (`ProfileLook`, `Colors`, `MeshGradient`, `FrostedStyle`, `Motion`…) and its `res` | the `:ardia-design` module: the look, the settings tokens | keep | `apps/phone/android/ardia-design/src/main/{java/com/ardia/design,res}` |
| `app`: `ArdiaWidgets`, `WidgetColors`, `SearchTileService`, `ShortcutActivity`, `SystemSnapshot(s)`, `ShareSheetModel`, `ShareSheetView`, and `res-system` | the Expo app: the widgets, the tile, the shortcuts, the share sheet | keep | `apps/phone/android/app/src/main/{java/com/ardia/browser/android,res-system}` |
| unit tests of kept code: `browser` (13), `blocking` (12, with 5 sample lists), `browsing`'s `PickedFileRuleTest` | nothing ran them in the Expo build | keep, now run by `corex-test` | `packages/phone/android/src/test/{java,resources}` |
| `app`'s `ShareSheetTest`, `SystemSnapshotTest`, `WidgetColorsTest`; `design`'s `ColorsTest`, `DrawingTest`, `ProfileLookTest` | nothing ran them | keep, now run by `corex-test` | the app's and `ardia-design`'s `src/test` |
| device tests of kept code: `browser` (12, with its test activity), `blocking` (1), `shared` (2), `sync` (6, with its documents provider) | `android.yml`'s emulator job | keep, not run anywhere yet | `packages/phone/android/src/androidTest` |
| `scripts/swift-crosscheck.sh` and `scripts/crosscheck` | the Kotlin and Swift sync vaults read each other's writes (`SwiftCrossCheckTest`) | replaced by committed test vectors: both sides seal the same fixed inputs to the same bytes and open each other's sets, with no Swift and Gradle on one machine | `packages/sync/tests/fixtures/sync-vectors`, `SyncVectorsTests.swift`, `SyncVectorsTest.kt` |
| everything else: the Compose screens, app shell and model (`app`, `appmodel`, `browsing`, `search`, `settings`, `store`, `tabs`, the rest of `design`), their tests, the Gradle project, wrapper and catalog, `gradle-locked` | the Compose app only | delete | |

**What else named `apps/android`:**
- `bundle-guard.ts`'s native paths: the old app folder goes; its files are now under `apps/phone/android`.
- `LegacyNamesTest`: it read four constants from the Compose sources. It now reads them frozen in
  `packages/phone/android/src/test/resources/com/ardia/phone/compose-store-names-01a149d87.tsv`, copied verbatim from the
  release reference's commit, where `HEAD` still had the same four.
- `android.yml`: it built and tested the Compose app. It now runs the Expo Android app's unit tests on pull requests
  that touch the phone's Android side or sync, behind the same `gate` job, so its `GATED_WORKFLOWS` entry stays.
- `docs/android.md`: it documented the Compose app and goes. This file is the Android documentation.
- `check-upgrade.py`, the upgrade gate and the legacy reader: they read only APKs and the phone's own sources.
- `.github/vouch/vouch.cjs`: unchanged.
- The site, dashboard, CLI and the Mac app name nothing in `apps/android`.

**The pinned references.** Both are kept outside the repo, on this Mac in `~/Developer/ardia-phone-references/`
(linked from the old `/tmp` paths) and on corex in `~/Developer/ardia-phone-apks/reference/`.

| File | Built from | How | sha256 |
|---|---|---|---|
| `ardia-compose-release.apk` | `01a149d87` | `:app:assembleRelease`: R8, resources shrunk, not debuggable, signed with this Mac's `~/.android/debug.keystore` (`eeb05c92…`) | `7fb9decc…de190` |
| `ardia-compose-upgrade17.apk` | `1e343bb81` | `:app:assembleDebug`: debuggable, the upgrade pair's Compose half, the same key | `4e7e4010…3f148` |

To rebuild either once `apps/android` is gone, run on corex, in the bots container:

```
ssh corex docker exec -i bots bash -lc "'bash -s -- release'" < apps/phone/scripts/rebuild-compose-reference
ssh corex docker exec -i bots bash -lc "'bash -s -- upgrade17'" < apps/phone/scripts/rebuild-compose-reference
```

The script does the following:
- exports the commit's `apps/android`, the sync bundle it compiled and the sync fixtures with `git archive` into
  `~/Developer/compose-rebuild/<name>`;
- runs the Compose app's own wrapper there without a daemon, under the Android Gradle lock;
- writes `<file>-rebuilt.apk` and `.txt` beside the pinned one;
- reports whether the package, versions, ABIs, manifest components and dex classes match.

Proven on 2026-11-16, with `apps/android` still present:
- **`release`** rebuilt in 582 s. Same package, versions, debuggable flag and ABIs, the same manifest components, and
  the same 6,158 dex classes as the pinned APK. It isn't byte-identical: 16,751,618 bytes against 16,847,017, another
  signer, and R8's own output.
- **`upgrade17`** rebuilt in 295 s. The same in each of those, with all 30,279 dex classes; 66,016,201 bytes against
  69,356,915.

A rebuild carries corex's debug key. For an install over the pinned one, re-sign it on this Mac:

```
apksigner sign --ks ~/.android/debug.keystore --ks-pass pass:android <apk>
```

**The upgrade tests' Compose store.** Two sources:
- `PhoneLegacyTest` writes its own Compose-shaped store from the schema it pins (`COMPOSE_SCHEMA`), so it needs no
  app.
- A store written by the Compose app itself, captured with `run-as` from `ardia-compose-upgrade17.apk` (debuggable)
  on a phone, is to be kept as a fixture beside `PhoneLegacyTest`. That's the clean-up's F4 step. Until it lands, the
  import is proven against the schema the test pins and against `check-upgrade.py` on the two APKs.

### The old iPhone app, cleaned out

The owner's order (2026-11-16), as for Android above: clean the SwiftUI app out of this branch, keeping only what the
Expo app builds from and what comparisons need. `main` keeps it until this branch merges.

**What the Expo app and the rest of the repo used from `apps/ios`** (250 tracked files, about 56,800 lines).

| In `apps/ios` | What used it | Decision | Now |
|---|---|---|---|
| `Packages/ArdiaKit` (ArdiaShared, ArdiaSync, ArdiaBrowser, ArdiaDesign) and its tests | the `ArdiaPhoneNative` pod (ArdiaBrowser, ArdiaDesign, through the Podfile's `link_ardia_kit`); the widgets and the share extension (ArdiaDesign); the PhoneMotion and PhoneSync test packages; Android's sync bundle (`ArdiaShared/Scripts/ardia-sync.js`); `ios.yml` | keep | `packages/phone/ios/ArdiaKit` |
| `Share`, `Action`, `Widgets` | the Expo project's three extension targets, compiled in place as synchronized folders | keep | `apps/phone/ios/{Share,Action,Widgets}` |
| `Config`: `Share`, `Open` and `Widgets` Info.plists and entitlements, `Ardia.entitlements`, `Ardia-DefaultBrowser.entitlements` | the Expo project's build settings; `defaultBrowserSwitch.test.ts` | keep | `apps/phone/ios/Config` |
| `Config/ExportOptions-TestFlight.plist` | `release-ios` | keep | `apps/phone/ios/Config` |
| `Config/TestFlight-WhatToTest.txt` | `ios-release.yml`'s public link step | keep | `apps/phone/ios/Config` |
| `Config/Ardia-Info.plist` | the SwiftUI app only (the Expo app has `apps/phone/ios/Ardia/Info.plist`) | delete | |
| `App/AppIcon.icon`, `App/Assets.xcassets` | the Expo app's icon and asset catalog | keep | `apps/phone/ios/App` |
| The rest of `App` (screens, app model, intents, its PrivacyInfo) | the SwiftUI app only; the Expo app has its own intents and `PrivacyInfo.xcprivacy` | delete | |
| `Ardia.xcodeproj`, `project.yml` | the SwiftUI app only | delete | |
| `scripts/asc.mjs` | `ios-release.yml` (status, next build, wait, public link, testers, certificates), `release-ios` | keep | `apps/phone/scripts/asc.mjs` |
| `scripts/bundle-shared.mjs` | the `packages/core` and `packages/sync` test scripts; `ios.yml` | keep | `apps/phone/scripts/bundle-shared.mjs` |
| `scripts/update-filter-catalog.mjs` | refreshes ArdiaBrowser's `FilterListCatalog.json`, which the iPhone ships | keep | `apps/phone/scripts/update-filter-catalog.mjs` |

**Outside `apps/ios`:**
- `scripts/release-ios.sh`: the SwiftUI app's TestFlight build, reached only through `ios-release.yml`'s `swiftui`
  path. It goes, and so do that path and the workflow's `app` input. The Expo app is the only iPhone app; build
  0.2.47 (9) stays on TestFlight as it is.
- `ios.yml`: its `app` job built the SwiftUI project and goes. Its `packages` job stays and also runs PhoneMotion and
  PhoneSync, so its `GATED_WORKFLOWS` entry in `.github/vouch/vouch.cjs` stays.
- `docs/ios.md`: it documented the SwiftUI app and goes. What is still true (the code shared with the Mac, the
  TestFlight secrets and the version scheme) is in this file.
- `.gitignore`, the Podfile, the Expo project, `build-sim-app`, `release-ios`, `packages/phone/android/build.gradle`
  (the sync bundle) and the PhoneMotion and PhoneSync manifests follow the moves.
- `ios-update-launch-check` and the upgrade proof take the SwiftUI app as a built `.app`, the pinned reference below.
  `PhoneSyncTests` writes its own SwiftUI-shaped store with ArdiaKit's schema, so it needs no app.
- The site, dashboard, CLI, extras, infra and the Mac app name nothing in `apps/ios`.

**The pinned reference.** `~/Developer/ardia-phone-references/swiftui-main.app` (linked from
`/tmp/ardia-phone/swiftui-main.app`), with `swiftui-main.txt`, is main's SwiftUI app built from
`e945077b66efc7595382510e4a3c78c8e541957f` (PR #2010's search morph): Release, for the simulator, ad hoc signed with
simulated entitlements. It is the one SwiftUI build the launch check, the upgrade proof and the speed comparisons
install. Install the folder, not the `/tmp` link: the Simlock upload refuses links. The previous pin, from
`a6ab643116b53c7a7079521adbb9374537eaec0f`, stays beside it as `swiftui-main-a6ab64311.app` until the audit rows for
search and the bar are re-checked against the new one. To rebuild it once
`apps/ios` is gone here:

```
apps/phone/scripts/rebuild-swiftui-reference [<commit>] [<out dir>]
```

The script does the following:
- exports the commit's `apps/ios` and `packages/sync` with `git archive` into a scratch folder;
- builds the SwiftUI project there under the xcodebuild lock, ad hoc signed as above;
- writes `swiftui-main-rebuilt.app` and its `.txt` beside the pinned one, and checks it carries its entitlements.

A comparison against main's newer SwiftUI app takes main's commit: `apps/phone/scripts/rebuild-swiftui-reference
origin/main`.

**The clean-up's commits**, reverted together to bring `apps/ios` back: d895a9e02 (this inventory and the pin),
73429dc8c (133 moves, no content), 58d5c392d (paths), 0ab20bbb3 (workflows and docs), aa1329b2e (119 files and
16,581 lines deleted: the rest of `apps/ios`, `scripts/release-ios.sh`, `docs/ios.md`) and 030844cdb (the
conventions check now covers ArdiaKit).

**Proved after it** (2026-11-16, at 030844cdb):
- `swift test` passes in ArdiaKit (219 tests), PhoneMotion (22) and PhoneSync (24) from their new homes.
- `release-ios 10 --version 0.2.47 --unsigned` passes every check, at 57.3 MB installed, as before the clean-up.
- `build-sim-app` builds the simulator app with its JavaScript from a clean export of the commit.
- `ios-update-launch-check` passes on a lease with the pinned SwiftUI build, and the Expo app imports the store that
  build wrote (receipt written, marker `imported`).
- `rebuild-swiftui-reference a6ab64311` rebuilds the pinned app: 1.0 (1), the same three extensions, entitlements
  present.
- The phone's typecheck and suites, `packages/core` and `packages/sync` pass, and so do the Mac app's typecheck and
  tests, except one dated test (`watch.test.mjs`, its fixed clock's 14-day watch ended on 15 Nov).
- Not proved: a native build from a fresh clone (`pnpm install` and `pod install` from nothing), for disk.

### The lab switch

The page lab (`com.ardia.phone.PAGE_LAB`) and sync's demo mode (`com.ardia.phone.SYNC_DEMO`) exist only in lab
builds. `gradle-locked` makes them: it passes `-PardiaLab=true`, which `@ardia/phone-native` turns into
`BuildConfig.ARDIA_LAB` (checked before either launch extra is read), and sets `EXPO_PUBLIC_ARDIA_LAB=true`, which
`index.js` reads at bundle time, so a build without it has no lab JavaScript at all and never makes the demo
controller. Even in a lab build the demo is refused while real sync is set up. The app's Gradle file fails the build
when the property and the variable disagree, and Metro's cache is keyed on the variable.

A store build leaves both off:

```
ARDIA_LAB=0 apps/phone/scripts/gradle-locked :app:bundleRelease
```

To see the lab with Metro, start it with `EXPO_PUBLIC_ARDIA_LAB=true pnpm -C apps/phone dev` and run a debug
build from `gradle-locked`.

### Launch arguments on Android

The iPhone's launch arguments are intent extras on Android, with the same names. Lab and debug builds read them
(`LaunchExtras.allowedInThisBuild`); a store build ignores them.

```
adb shell am start -S -n com.ardia.browser.android.dev/com.ardia.browser.android.MainActivity --ez ArdiaDemo true --es BrowseQuery otters
```

`ArdiaDemo` runs on demo data (two Macs, two profiles) and never touches real data. The rest drive captures without
touch:
- `BrowseOpen <url>`, `BrowseQuery <text>`, `BrowseSurface browsing`, `BrowseTab <n>`, `BrowseToolbar`, `BrowseReader`,
  `BrowseIncognito`, `BrowseDelay <s>`;
- `BrowseDeck`, `BrowseDeckOpen <n>`, `BrowsePlus`, `BrowseOverlay <text>`, `BrowseSteps <n,n>` with
  `BrowseStepGap <s>`;
- `ArdiaDeck <script>`, `ArdiaOnboarding`, `ArdiaOpenSheet <sheet>`, `ArdiaOpenSettings`, `ArdiaRestingStart`,
  `ArdiaColor <name>`, `ArdiaToast <text>`, `ArdiaTrustedSites`;
- `ArdiaWithoutPrivatePages` (Android only) makes the page engine act as on a WebView without multi-profile support,
  so Incognito is refused with its "Update Android System WebView for Incognito" toast;
- motion captures, demo only: `BrowsePagerFreeze <fraction>`, `BrowsePagerScript`, `BrowseLoadFreeze <progress>`;
- the lab's own flags, such as `ArdiaOneContainerScroll`, `ArdiaOpeningCard`, `ArdiaNativeGlass` and `ArdiaRedesign` (Android draws the redesigned design, for checking the page under the bar before it becomes Android's default).

Flags take `--ez` (or any string but false, no and 0); everything else can be `--es`. The list is `LaunchArguments.kt`
(`packages/phone/android/src/main/java/com/ardia/appmodel`).

### Size on Android

What an arm64 phone downloads and installs. "Download" is every entry an arm64 phone gets, each deflated on its own
(zlib level 9), which is close to what the Play Store sends; a directly downloaded APK costs its file size. Store
builds (R8 on, lab off) against the Compose app's non-debuggable release (`ardia-compose-release.apk`, R8 and
resource shrinking).

| Build | File | Download | Installed |
| --- | --- | --- | --- |
| Expo 58 / React Native 0.88, arm64-v8a (7dd666526, without `@expo/ui`) | 41.0 MB | 15.6 MB | 41.0 MB |
| The same with `@expo/ui` 58.0.28 linked | 45.8 MB | 17.6 MB | 45.8 MB |
| Expo 54 / React Native 0.81, arm64-v8a (266764af8) | 38.9 MB | about 14 MB | 38.9 MB |
| Expo 54 with arm64-v8a and x86_64 (the release build until 8af216ccb) | 57.7 MB | | 57.7 MB |
| Compose release, arm64-v8a only (its x86_64 libraries taken out) | about 12.0 MB | 5.7 MB | about 12 MB |

An earlier version of this table gave the Expo 54 download as about 10.2 MB and both ABIs as about 14.5 MB: those
were wrong, since its own parts (6.1 + 5.7 + 1.7 MB deflated, plus resources) already come to about 14. The Expo
app bundle (`build-apk --bundle`, 25.4 MB with debug symbols) hands an arm64 phone the same native code and dex,
so its download is about the arm64 APK's.

By part, arm64-v8a only, file (deflated):

| Part | Expo 58 | Expo 54 | Compose |
| --- | --- | --- | --- |
| Native libraries | 22.7 MB (7.8) | 18.1 MB (6.1) | 4.7 MB (1.8) |
| Dex after R8 | 11.5 MB (4.8) | 14.7 MB (5.7) | 5.5 MB (2.8) |
| JS bundle (Hermes bytecode) | 4.5 MB (1.8) | 3.9 MB (1.7) | none |
| Resources and assets | 2.3 MB (0.9) | about 1.5 MB | about 1.3 MB |

The Expo build stores the native libraries, the dex and the bundle uncompressed, so Android maps them straight from
the APK: what the file costs is what the phone keeps.

Where Expo 58's 22.7 MB of native code goes: React Native 7.1 MB, Hermes V1 2.7 (`libhermesvm.so`, which the sync
runtime shares), expo-sqlite 1.7 (the app's database), Reanimated 1.7, Expo's modules core 1.6, worklets 1.3, the C++
runtime 1.3, the generated app modules 1.0, SVG 0.8 (the logo and the sync pictures), zstd 0.7 (`expo/fetch`'s
decompression, new in 58), Fresco's image transcoder 0.6, then JSI, Gesture Handler's codegen, Expo's modules v2 and
the rest. The page engine is the system WebView, so it costs nothing here; sync is Kotlin and sits in the dex.
From 54 to 58 the native code grew 4.6 MB (React Native 1.2, Hermes V1 0.6, zstd 0.7, Expo's two module layers 0.6,
Reanimated and worklets 0.7) and the dex shrank 3.2 MB, since AGP 9 runs R8 with its optimize preset.

`@expo/ui` adds no native code: 3.7 MB of dex (1.6 deflated) and 1.2 MB of resources (0.3 deflated), 4.8 MB on the
file and 2.0 MB on the download. Most of it is not Compose, which the app already ships for its widgets and share
sheet, but Material Components for Android (`com.google.android.material`) with the RecyclerView, ViewPager2,
CardView and CoordinatorLayout it pulls in.

Where the Expo 54 dex went, by the classes' original package: kotlin.reflect 1.1 MB (Expo's modules need it),
React Native 1.0, Compose UI, runtime and Glance 1.6 together (the widgets and the share sheet), CameraX 1.0 (only
the sync code scanner), our own code 0.5, Expo's Kotlin layer 0.5, then AndroidX, OkHttp, kotlinx and the rest.

On an arm64 phone the Expo app is between three and four times the Compose release: 41.0 MB against about 12 on
the file, 15.6 against 5.7 on the download, before `@expo/ui`. The difference is React Native itself: its
libraries, Hermes, Reanimated, worklets and Expo's modules come to about 18 MB of native code the Compose app doesn't
have, and the JS bundle adds 4.5 MB.

Nothing big can go without losing something:
- x86_64 runs only on emulators and a few Chromebooks, so release builds leave it out; `--abi arm64-v8a,x86_64`
  builds it for an x86_64 emulator. Nothing 32-bit is built, so a 32-bit-only phone can't install the app.
- There are no fonts, and no image or resource shipped twice (under 2 KB of duplicates).
- expo-sqlite, SVG, Reanimated, worklets and kotlin.reflect are in use.
- CameraX serves only the sync code scanner, which a release build hides; it stays for now.

Packaging (`apps/phone/scripts/build-apk`):

```
build-apk <name> --store --bundle               the Play Store's app bundle, <name>.aab, checked on <name>-universal.apk
build-apk <name> --store                        a direct-download APK, arm64-v8a only, libraries and dex stored
build-apk <name> --store --compress libs,dex    the same with libraries and dex compressed, about 16 MB to download
```

The same arm64-v8a store build packed four ways (8af216ccb): libraries and dex stored 38.9 MB, libraries compressed
26.8 MB, dex compressed 30.0 MB, both compressed 17.9 MB. The universal APK made from the AAB is 30.1 MB, because
bundletool compresses its dex.

`--compress` is not the default yet: the F4 compares cold start (to the first frame and, by logcat's "Fully drawn"
line, to the app's own UI) and the first deck open against the stored build, with each one's installed size. Every
R8 build has to pass `check-names.py`.

### Size on iPhone

What an iPhone downloads and installs, measured 2026-11-16 without uploading anything. Each app was archived for a
generic iOS device, Release, with code signing off: Expo 58 / React Native 0.88 at 773ee4ded, against main's SwiftUI
app. Nothing touched the Apple developer account. An unsigned archive can't be exported, so there is no Xcode
thinning report.

- **Installed:** the archived `.app`, arm64 only.
- **Download:** the payload zipped at level 9, close to an `.ipa`. App Store Connect's own report will be the real
  figure: the App Store encrypts the executables, which then compress less, and thins the asset catalog.
- **Simulator:** the simulator builds measure 86.4 and 46.4 MB, because they keep debug symbols and simulator-only
  code. Don't quote those for a phone.

| Build | Installed | Download (zip -9) |
| --- | --- | --- |
| Expo 58 before the strip (773ee4ded) | 60.0 MB | 26.3 MB |
| Expo 58 as it builds now, with the Release strip of React Native's prebuilt frameworks | 56.5 MB | 25.7 MB |
| main's SwiftUI app | 27.7 MB | 16.6 MB |
| Both, after the App Store drops the iPad copies of the app icon (estimate) | about 4.3 MB less each | about 4.3 MB less each |

By part, installed (deflated):

| Part | Expo 58 | SwiftUI |
| --- | --- | --- |
| App binary | 12.7 MB (4.7) | 5.9 MB (2.4) |
| React Native's frameworks: React 11.6, hermesvm 6.1, ReactNativeDependencies 1.2, ExpoModulesJSI 1.2 | 20.1 MB as shipped, 16.5 after the Release strip: React 10.1, hermesvm 4.2, ReactNativeDependencies 1.1, ExpoModulesJSI 1.2 | none |
| JS bundle (Hermes bytecode) | 5.4 MB (2.2) | none |
| The three extensions (Share, Open in Ardia, Widgets) | 11.2 MB (4.4) | 11.2 MB (4.4) |
| Asset catalog | 9.4 MB (9.3) | 9.5 MB (9.4) |
| ArdiaKit's resource bundles | 1.0 MB | 0.9 MB |

**Where the Expo binary's 11.5 MB of linked code goes** (from its link map):
- our native module with ArdiaKit linked in: 3.2 MB;
- Expo UI: 2.2;
- Expo's modules core: 1.3;
- expo-sqlite: 1.2;
- Reanimated: 1.0;
- SVG: 0.5;
- worklets: 0.4;
- expo-file-system: 0.4;
- then React Native's codegen, Gesture Handler, Expo's other modules and the linker's own.

The SwiftUI app's 5.9 MB binary is ArdiaKit plus its SwiftUI screens.

**The asset catalog is the largest part of both downloads, and it is the app icon.** The Icon Composer icon is stored
as 1024 px renditions (any, dark, tinted), each once for iPhone and once for iPad: 8.6 of its 9.4 MB. It barely
compresses. The App Store's thinning sends an iPhone only its own copies, about 4.3 MB less. Both apps carry the same
icon, so it doesn't change the difference between them.

**What could go without losing anything:**
1. **The debug map in React Native's prebuilt frameworks, now stripped in Release.**
   - Xcode strips what it builds, but these four come prebuilt and are copied in as they ship. React and Hermes
     carry a debug map: about 88,000 entries naming object files on the machine that built them, which nothing on a
     phone or in a crash report can use.
   - The "Strip prebuilt symbols" build phase runs `apps/phone/ios/strip-prebuilt-symbols.sh` after CocoaPods'
     "Embed Pods Frameworks", in Release only. It runs `strip -S`, then re-signs each framework when the build
     signs. That saves 3.6 MB installed and 0.6 MB of download.
   - Function names stay, local ones included: the same 40,160 symbols before and after. React Native's prebuilt
     frameworks ship no dSYMs (only ExpoModulesJSI has one), so these names are what makes their frames in a
     crash report readable. Proof on the stripped device archive: `atos` names a React and a Hermes local function
     from the stripped binaries. Our own code goes through the archive's dSYMs, which stay with the archive: the app
     binary's UUID matches `Ardia.app.dSYM`, and an address in it resolves to `SettingsShortcutsView.body.getter
     (SettingsUIModule.swift:148)`.
   - `strip -x -S` would save 5.5 MB more installed, but it removes the local function names, and with no dSYM for
     these frameworks nothing can restore them. lldb then shows `___lldb_unnamed_symbol…` for React and Hermes
     frames. Not worth 0.3 MB of download.
   - The stripped build passes `ios-update-launch-check`, onboards and loads a page.
2. **The app icon's iPad copies** are the App Store's to thin. Nothing to do in the build.
3. **Nothing else:**
   - Expo UI draws the Settings screens; expo-sqlite is the app's store; SVG draws the logo and the sync pictures;
     Reanimated and worklets carry the motion.
   - The extensions are the same in both apps.

Read the real per-device download and install sizes from App Store Connect when the internal TestFlight build goes
up.

**Estimate for an iPhone after the strip and the App Store's thinning:**

| | Expo | SwiftUI |
| --- | --- | --- |
| Installed | about 52 MB | about 23 MB |
| Download | about 21.5 MB | about 12.5 MB |

The App Store's encryption of the executables can add a few megabytes to both downloads. So on an iPhone the Expo
app is about twice the SwiftUI app. React Native itself (React, Hermes, Expo's modules) and the JS bundle are the
difference, as on Android.

### iPhone

```
scripts/agent/locked pod -- bash -c 'cd apps/phone/ios && pod install'     after native dependencies change
scripts/agent/locked xcodebuild -- xcodebuild -workspace apps/phone/ios/Ardia.xcworkspace -scheme Ardia \
  -configuration Release -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath <your own dir> ARCHS=arm64 CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY=- \
  DEVELOPMENT_TEAM= PROVISIONING_PROFILE_SPECIFIER= build                                   JS bundled in
agent-device install com.ardia.browser.ios <dir>/Build/Products/Release-iphonesimulator/Ardia.app
```

The ad hoc identity signs locally for the simulator with each target's entitlements (the app group, so the app and
its extensions share the SwiftUI app's container) and needs no account or profile. The Podfile adds
`packages/phone/ios/ArdiaKit` to the `ArdiaPhoneNative` pod as a local Swift package (ArdiaBrowser and ArdiaDesign);
Xcode links ArdiaKit into the pod's library and copies its resource bundles into the app. The app target must not
link ArdiaKit itself, or every symbol is linked twice; it finds ArdiaDesign's module for its intents through
`SWIFT_INCLUDE_PATHS`. iOS 27 refuses to launch an app without the scene lifecycle, which Expo 54's template lacks, so
`SceneDelegate` starts React Native in the scene's window and hands links, quick actions and Handoff to the module.

The project carries the SwiftUI app's extensions, compiled from `apps/phone/ios/Share`, `Action` and `Widgets`, with
the Info.plists and entitlement files in `apps/phone/ios/Config`: the Share extension, Open in Ardia and the widgets, under the same
bundle ids. The SwiftUI app's intents need its `AppModel`, so the app target has its own copies with the same names,
titles and phrases that post links instead.

- `system.initialLink()` and `system.addLinkListener()`: `{ kind, source }` with kind `open` (url), `search` (query),
  `voiceSearch`, `incognito`, `tab` (id), `macTabs` or `inbox`, and source `web` (an http link from another app),
  `system` (an `ardia://` link from a widget, the share sheet or the action), `shortcut`, `share` (the share
  sheet's inbox, when it couldn't open the app), `handoff` or `intent`.
- `defaultBrowser`: `status()` from ArdiaBrowser's `DefaultBrowserStatus`, shared with the SwiftUI app;
  `requestRole()` is always false on iPhone, which has no role prompt; `openDefaultAppsSettings()`.
- `legacy.available()` and `legacy.read()`: the SwiftUI app's tabs, archive, history and preferences, read from a
  copy of its SwiftData store so the store itself is never opened. `-ArdiaLegacyDump YES` logs what `read()` returns
  (`ARDIA_LEGACY` lines) and `-ArdiaLegacyRestore YES` also opens the first saved tab, for checking an import;
  `-ArdiaLogSystemLinks YES` logs each link (`ARDIA_SYSTEM_LINK`). These need a test build (below).

#### Seeing a change on an iPhone simulator, beside main's SwiftUI app

Watch your own frames before you hand a change on. The loop, for any agent:

1. **Build.** `apps/phone/scripts/build-sim-app <name> [--commit REV]` makes `/tmp/ardia-phone/<name>.app` (Release,
   simulator, lab on) and `<name>.txt` beside it.
   - The JavaScript is bundled from a `git archive` export of REV (default HEAD), never the working tree.
   - The native app is built from the working tree once and cached under a hash of its inputs (`apps/phone/ios`
     with its Podfile.lock, `packages/phone/ios`, ArdiaKit, `app.json`, the module config, the lockfile, `patches`).
   - When those didn't change, only the bundle is rebuilt into a copy of the cached app, which is then re-signed ad
     hoc: about 25 seconds, against about 2 to 2.5 minutes for a full native build (504a9db41).
   - It refuses below 4 GB free, below 6 GB when the native app is rebuilt over its cached build products, and below 10 GB when it is built from nothing; it runs one at a time and cleans its own scratch.
   - The `.txt` carries the commit, dirty, the bundle source, the native state, whether the native app was built or
     reused, and the bundle's sha256. The app logs the same at launch as `ARDIA build <commit> dirty: … from the …;
     native …`.
2. **Simulator.** In T3, `device_open` with host `simlock` and an id like `simlock:ios:iPhone 17 Pro` leases a booted
   simulator and returns its `agent-device` command; every tap, screenshot and launch goes through that command. The
   lease is wiped when it ends: close it with `device_close` (`shutdown: true`). Its udid, for `simctl`'s logs and
   recordings: `xcrun simctl --set ~/.simlock/devices/ios list devices booted`.
3. **Install and launch,** from the repo root (the lease accepts installs only from this checkout):
   `<agent-device> install com.ardia.browser.ios /tmp/ardia-phone/<name>.app`, then
   `<agent-device> open com.ardia.browser.ios --relaunch --launch-args -ArdiaDemo --launch-args YES`. Add
   `--launch-args -BrowseDeck --launch-args YES` to open on the deck. Confirm the build:
   `xcrun simctl --set ~/.simlock/devices/ios spawn <udid> log show --last 2m --style compact --predicate 'eventMessage CONTAINS "ARDIA build"'`.
4. **Record.** Start `xcrun simctl --set ~/.simlock/devices/ios io <udid> recordVideo --codec h264 --force run.mp4` in
   the background, act through `agent-device`, then `kill -INT` the recorder; `agent-device record` comes back empty
   under load. A still at device resolution: `<agent-device> screenshot shot.png --pixel-density 3` (3 px = 1 pt).
5. **Frames.**
   - Find the event by frame difference: `ffmpeg -i run.mp4 -vf "fps=60,scale=201:437,signalstats,metadata=print:key=lavfi.signalstats.YDIF" -f null - 2>&1 | grep YDIF`.
   - Pull 60 fps frames: `ffmpeg -i run.mp4 -vf fps=60 frames/f%04d.png`.
   - Or a sheet: `-vf "fps=60,select='between(n,START,END)',scale=134:291,tile=18x2" -frames:v 1 sheet.png`.
   - Measure positions, sizes and opacity from the pixels, not by eye.
6. **Main's SwiftUI app,** the reference for the iPhone redesign.
   - It has the same bundle id, so uninstall one app before installing the other
     (`xcrun simctl --set ~/.simlock/devices/ios uninstall <udid> com.ardia.browser.ios`).
   - The pinned Release build is `~/Developer/ardia-phone-references/swiftui-main.app` (linked from
     `/tmp/ardia-phone/swiftui-main.app`), with `swiftui-main.txt` saying from which commit. To make a fresh one from
     any commit of main (about 50 s), run `apps/phone/scripts/rebuild-swiftui-reference <commit>`: it builds that
     commit's `apps/ios` from a `git archive` export and signs it ad hoc, never with `CODE_SIGNING_ALLOWED=NO`.
     The ad hoc build carries simulated entitlements
     (`application-identifier` `FAKETEAMID.com.ardia.browser.ios` and the app group), the same as `build-sim-app`'s
     Expo builds. Without them the app has no Keychain: Sync With Mac stops at "Couldn't save the sync key in your
     Keychain", and an upgrade can't carry the key over. Check with
     `otool -l <app>/Ardia | grep -c 'sectname __entitlements'` (1).
   - Its launch arguments: `-ArdiaDemo YES`, `-ArdiaDeck deck`, `-ArdiaInterfaceStyle classic`,
     `-ArdiaColorScheme dark`, `-ArdiaOpenSheet history`, `-ArdiaSpace <syncId>` (all in `SettingsLaunchHooks.swift`).
   - Record both apps doing the same thing in the same state, light and dark, and compare the same crop.
7. **Traps.**
   - A fresh lease's first keyboard shows the "Type English and Hindi" tip over the keys. Press its Continue, which
     appears in a plain `snapshot` (not `snapshot -i`), before typing, or a Go press does nothing.
   - In zsh, `$var:a…` is a modifier; write `${var}:path`.
   - Simlock has leased one simulator to two agents at once: the screens agent's lease id and mine were the same
     (a537518c…), and our taps and launches crossed, which spoiled a memory reading. Before measuring, check the
     device id `device_open` returned against the other agents' lease ids, and the udid's device type against the
     model you asked for (`plutil -extract deviceType raw ~/.simlock/devices/ios/<udid>/device.plist`).
   - One model per agent, always the same: the iPhone agent leases only `simlock:ios:iPhone 17 Pro`, the screens agent only `simlock:ios:iPhone 18 Pro`, the coordinator only `simlock:ios:iPhone 17`; on Android the Android agent takes Pixel 8 and the screens agent Pixel 9. A refused lease means wait, never another model.
   - `refused: this agent-device is too old to use through a gateway; update it` from a command `device_open` just returned means the lease was dropped (its simulator is no longer booted, usually under a load spike), not that the tool is old: check `simctl --set ~/.simlock/devices/ios list devices booted`, then lease again.
   - Before the first install on a lease, print its udid and list its installed apps: a lease starts empty, so an app already there is someone's live session. Close the lease without touching it and tell the coordinator.
   - Why: Simlock has twice handed one simulator to two agents while both were active (a537518c…, then 97D6E59E… on 2026-11-16, where one agent's install wiped the other's connected test app).
   - Close Search is pressed by coordinate, above the panel (e.g. `press 200 120`), in both apps: a press by its ref
     taps the centre of its full-screen frame, which the panel covers, so it closes neither ours nor main's. That says
     nothing about VoiceOver, whose activate runs the dim's accessibility action (92e0f865c); that needs a device.

#### Speed against the SwiftUI app

The question is whether the Expo app is slower than the SwiftUI app it replaces on iPhone. The bar is main's SwiftUI
app, built Release for the same simulator (`/tmp/ardia-phone/swiftui-main.app`), against a Release `build-sim-app`
build of the Expo app from head.

Three runs so far: on Expo 54 / React Native 0.81 (first table), on Expo 58 / React Native 0.88 with Reanimated's
settled re-render on (second table), and on 0.88 with it off (third table, cfbdc5050's
`FORCE_REACT_RENDER_FOR_SETTLED_ANIMATIONS: false`). The third table is the current one.

Expo 54 / React Native 0.81: measured 2026-11-15 on one leased iPhone 17 Pro simulator (iOS 27), Expo at 5fbcd2308 and SwiftUI from main, at a
load under 10 and under `scripts/agent/locked perflab`. Each timed row is the median of five recordings, taken in
four rounds that alternate the apps. Times run from the first frame that changes to the last change before 0.5 s of
stillness. The recordings, frame scripts and pages are in `/tmp/ardia-phone-shots/iphone-agent-speed/`
(`rec/<app>-<measure>-<round><n>.mp4`, `analysis.json`).

| Measure | SwiftUI | Expo | Difference | Judgement | Simulator trust |
|---|---|---|---|---|---|
| App size on disk (simulator build) | 47.5 MB | 72.0 MB | +24.5 MB (+52%) | larger | Good for the difference; a device download is thinned and compressed. The extensions are equal (21 MB each); the gap is React Native and Hermes (16.9 MB of frameworks, a 5.5 MB bundle, a 2 MB larger binary). |
| Cold launch, first frame to settled | 395 ms | 410 ms | +15 ms (+4%) | level | Weak. The recording shows iOS's launch zoom over its cached launch snapshot, so it times iOS more than the app; the app's first own frame and a usable start page can't be told apart on video. Needs Instruments App Launch on a device. |
| Deck opening from a page, settled | 233 ms | 305 ms | +72 ms (+31%) | slower | Animation length and our own work carry over; GPU cost of the deck's glass and blur doesn't. SwiftUI's first change is the Tabs button's press, with motion 47 ms later; Expo shows no press and its first change is the motion. |
| Card opening from the deck, settled | 167 ms | 508 ms | +341 ms (3×) | slower | Carries over: the growth itself runs about 320 ms against SwiftUI's 167, and then the page jumps about 64 pt up and the bar appears at about 395 ms (the card's snapshot sits a status bar lower than the live page). Frames: `card-open-expo-frames.png`, `card-open-swiftui-frames.png`. |
| Search panel open to keyboard up and focused | 570 ms | 657 ms | +87 ms (+15%) | slower | Our part carries over; the keyboard's own animation is the simulator's. |
| Search submitted to the page's first paint (cached) | 112 ms | 95 ms | −17 ms | level | WebKit runs on the Mac's CPU; only the difference means anything. |
| Search submitted to settled | 515 ms | 382 ms | −133 ms (−26%) | faster | As above. |
| Tab swipe in the pager, settled (the 250 ms drag included) | 850 ms | 990 ms | +140 ms (+16%) | slower | The spring's length carries over. |
| Back and forward by edge swipe | cannot be measured | cannot be measured | | | agent-device's gestures can't start at the screen edge; needs a device. |
| Deck scrolling, frames over 34 ms per scripted swipe pair | 0 of 51–75 | 0 of 69–96 | none in either | level | Weak: simulator recordings are variable rate and not locked to the display, and the frame pacing is the Mac's. Hitches need Instruments Animation Hitches on a device. |
| Memory after nine tabs (app + WebKit) | 416 MB (154 + 263) | 387 MB (165 + 222) | −29 MB | level | The app process carries over roughly (Expo +11 MB). WebKit's content processes run 33 MB each in Expo and 40 MB in SwiftUI here, which a device's limits may not repeat. |
| Memory after a minute idle on the deck | 449 MB (185 + 264) | 388 MB (167 + 221) | −61 MB | lower | SwiftUI's app process grows 31 MB on the deck; Expo's 2 MB. As above for WebKit. |

What to fix before a device run, from these numbers:
- **Card opening** is the one real gap: three times as long, with a visible jump at the end. It is the screens
  agent's card handover.
- **Deck, search panel and pager** run 15–31% longer, which reads as the animations' set lengths and springs, not
  frame drops. Each is worth matching to SwiftUI's timing curve by curve.

Expo 58 / React Native 0.88: measured 2026-11-15, Expo at dc1bdecad (with the screens agent's main-token motion, 15c4af926,
and the card handover fix) against the same SwiftUI build, same simulator model, same method and pages, four
alternating rounds, five recordings per measure. The load stayed under 15 for rounds one to three; the last
SwiftUI round ended at 72, so its rows lean slow. Recordings and the analysis: `/tmp/ardia-phone-shots/iphone-agent-speed-088/`.

| Measure | SwiftUI | Expo 58 | Difference | Judgement | Against 0.81 |
|---|---|---|---|---|---|
| App size on disk (simulator build, `du -sk`) | 46.4 MB | 86.4 MB | +40.0 MB (+86%) | larger | Up from 72.0 MB: the app binary 29.1 MB (was 17.6; the new architecture's C++ and ExpoUI's SwiftUI link in statically), React Native's frameworks 20.2 MB (16.9), the bundle 5.4 MB, the extensions 21.0 MB as before |
| Cold launch, first frame to settled | 403 ms | 405 ms | +2 ms | level | level; still mostly iOS's launch zoom |
| Deck opening from a page, settled | 217 ms | 137 ms | −80 ms | faster | from +31%: the deck now runs main's arrive curve over 190 ms, which moves hard for 150 ms; main's spring has a longer tail |
| Card opening from the deck, settled | 172 ms | 293 ms | +121 ms (+70%) | slower | from 3×; the 64 pt jump is gone, and the bar's late arrival at about 290 ms is what remains |
| Search panel open to keyboard up and focused | 568 ms | 423 ms | −145 ms (−26%) | faster | from +15%: main's rise curve over 360 ms |
| Search submitted to the page's first paint (cached) | 130 ms | 83 ms | −47 ms | faster | as before, WebKit's own time |
| Search submitted to settled | 498 ms | 282 ms | −216 ms (−43%) | faster | |
| Tab swipe in the pager, settled (the 250 ms drag included) | 855 ms | 803 ms | −52 ms (−6%) | level | from +16%: main's 0.26/1 spring |
| Search panel's departure on Go: first change to the panel moving (773ee4ded, 3 runs each) | 285 ms (255–287) | 192 ms (178–192) | −93 ms | faster | was frozen 230–320 ms on 0.88 before MotionView; the screens agent's 50 ms strips show it gone by about 150 ms against main's 200 (`/tmp/ardia-phone-shots/lift-sim-58/`) |
| Back and forward by edge swipe | cannot be measured | cannot be measured | | | needs a device |
| Deck scrolling, frames over 34 ms per scripted swipe pair | 0 of 36–50 | 0 of 32–66 | none in either | level | weak on a simulator |
| Memory after nine tabs (app + WebKit) | 318 MB (124–129 + 189–194) | 360–415 MB (161–190 + 199–225) | +42 to +97 MB | higher | was lower on 0.81; the app process is 37–61 MB above SwiftUI's and WebKit 10–31 MB |
| Memory after a minute idle on the deck | 387–390 MB (186–189 + 201) | 356–401 MB (155–183 + 201–218) | −34 to +11 MB | level | |

Expo 58 / React Native 0.88 with Reanimated's settled re-render off: measured 2026-11-16 02:37–03:09, Expo's JS at
a987eb84b with native d82a2839d (Pods installed after cfbdc5050, so `RNReanimated.release.xcconfig` carries
`FORCE_REACT_RENDER_FOR_SETTLED_ANIMATIONS:false`), against the same SwiftUI build. Same simulator model, method and
nine pages, four alternating rounds, five recordings per measure, load 2 to 4 throughout, under the perflab lock.
Evidence: `/tmp/ardia-phone-shots/iphone-agent-speed-nf/`.

| Measure | SwiftUI | Expo 58 | Difference | Judgement | Against the second table |
|---|---|---|---|---|---|
| Cold launch, first frame to settled | 402 ms | 403 ms | +1 ms | level | level |
| Deck opening from a page, settled | 240 ms | 133 ms | −107 ms | faster | Expo level (137); main's 217 read low last time |
| Card opening from the deck, settled | 175 ms | 265 ms | +90 ms (+51%) | slower | Expo 28 ms faster than 293 |
| Card opening, re-timed 2026-11-16 at 996b1f307 (growth in MotionView, page mounted at the tap; 10 opens each, load 2.5–3.9) | 173 ms (163–180) | 195 ms (188–212) | +22 ms (+13%) | close, not level | from +90 ms; deck open in the same run 231 against 138 |
| Card opening, re-timed 2026-11-16 at 51c36153c (de35df77d's header and bar fading over the growing card; 10 opens each, load 2.4–3.5) | 172.5 ms (165–182) | 177 ms (175–193) | +4.5 ms | level | under a frame and inside main's own spread; deck open in the same run 237 against 137.5 |
| Search panel open to keyboard up and focused | 578 ms | 418 ms | −160 ms (−28%) | faster | level |
| Search submitted to settled | 512 ms | 298 ms | −214 ms (−42%) | faster | level |
| Tab swipe in the pager, settled (the 250 ms drag included) | 848 ms | 800 ms | −48 ms (−6%) | level | level |
| Deck scroll, frames over 34 ms | 0 in 5 | 0 in 5 | none in either | level | level |
| Memory after nine tabs (app + WebKit) | 381–405 MB (138–153 + 243–252) | 380 MB (171–172 + 208–209) | −25 to 0 MB | level | was higher; within the run-to-run noise either way |
| Memory after a minute idle on the deck | 430–434 MB (183–184 + 246–251) | 380–395 MB (179–183 + 201–212) | −35 to −54 MB | lower | |

**Card opening, frame by frame** (one recording each, `expo-handover.png` in the evidence folder): both cards grow
to full size over the same 170 ms. Main's address bar arrives during the growth, so its open ends there. Expo's card
lands with its rounded corners and a sliver of the deck at the edge, holds still for 75 ms, then the bar appears and
the corners go square in one change. That late hand-over is the whole remaining gap. Turning the settled re-render
off took 28 ms off it, and nothing else moved beyond the noise.

At 996b1f307 the hold is gone: Expo's open is one continuous change from the first frame (1.855 to 2.050 s in
`expo-card-a2.mp4`). Its card is still round-cornered with the deck at its edge at 2.030 s, and the bar arrives and
the corners square off in one step by 2.05 s. Main's deck bar instead fades into the page's bar during the growth, and
main is settled at 2.282 s, 174 ms after it starts. What's left is about one frame, from that step at the end
(`/tmp/ardia-phone-shots/iphone-agent-card-996b/`, `expo-tail.png` and `main-tail.png`).

What 0.88 leaves to fix, from these numbers:
- **Card opening is level** since 51c36153c: 177 ms against 172.5, 4.5 ms apart, under a frame. With that, every
  timed row in the iPhone table is level with main's app or faster. Starting the growth in the tap's own frame (MotionView's
  `from`) was tried and left out on iPhone: the page's readiness waits then ran to their 250 ms cap, and the page took
  over at about 300 ms.
- **Memory after nine tabs** is higher than SwiftUI's and higher than on 0.81. Hermes V1 and Reanimated 4.7 had a
  known memory regression before Expo 57.0.17; 58.0.25 should carry the fix. Worth a device check before the owner's
  phone, and an Instruments allocation trace of the app process.
- **Size** grew by 14 MB with the upgrade and ExpoUI; a device download is thinned and compressed, so measure the
  App Store Connect size when the internal build goes up.

**Memory split** (2026-11-16, 773ee4ded, nine local pages each, the two apps one after the other on the same
simulator, `footprint` and `vmmap --summary`):

| | App | WebKit | Total |
| --- | --- | --- | --- |
| Expo | 189 MB | 225 MB | 414 MB |
| Main | 158 MB | 260 MB | 418 MB |

These totals are level. Between runs, though, the same build moves by 30 to 70 MB: main's WebKit read 189–264 MB on
the same nine pages. So the 0.88 table's "higher" is within the noise, and the split is the useful part.

Inside the app process, dirty plus compressed:

| Region | Expo | Main | What it is |
| --- | --- | --- | --- |
| Malloc small | 78 MB | 51 MB | Native objects: React's Fabric trees and the views behind them, Expo's modules, Expo UI's hosting. About 28 MB of React Native and Expo that main doesn't have. |
| Untagged anonymous | 39 MB | none | Hermes V1's heap, the JavaScript state. |
| CG raster data | 27 MB | 27 MB | Decoded page pictures. The same, so the kept-mounted deck costs no more than main's. |
| Image IO | 13 MB | none | ImageIO's cache of decoded images behind React Native's Image. |
| WebKit's allocator in the app | 3 MB | 48 MB | WebKit's UI-process state. Main keeps far more of it in its own process. |
| Loaded code's data | 15 MB | 15 MB | The same. |

Two things stand out:
- **Each WebContent process** is 33 MB in Expo and 40 MB in main, about 35 MB less over nine pages.
- **What's plainly ours to release** is the Image IO cache: 13 MB of decoded copies of pictures that are already on
  screen as raster data. React Native's Image keeps them for reuse. A memory-warning or background purge, or drawing
  the deck's pictures without RN's image cache, would free most of it.
- **Hermes's 39 MB** is the cost of running JavaScript. It can be checked for growth with
  `HermesInternal.getInstrumentedStats()` over a long session, but not removed.
- **Neither Hermes V1's known regression** (fixed by Expo 57.0.17, and this is 58.0.25) nor Expo UI shows as a
  region of its own here.
- **The search panel's lift** no longer holds: with the departure in MotionView (773ee4ded) it starts at Go. The hold
  itself (the app's frames not reaching the screen while a new page view comes in) is still there underneath, so
  any other motion that overlaps a page arriving should run in Core Animation too.

The method:
- **Setup:**
  - Both apps on one leased iPhone 17 Pro simulator, iOS 27.
  - Fresh install and onboarding, then the same nine local pages (`http://localhost:8766/p1.html` … `p9.html`, each a coloured header and text, so the network doesn't vary).
- **Recording:** each measure recorded five times with `simctl io recordVideo`, the two apps alternating in rounds.
- **Reading the frames:** times come from the frames.
  - The first frame that changes is the touch's own response, such as the button's press.
  - The first large change is the result starting.
  - The settle is the last change before 0.5 s of stillness.
  - The touch itself isn't in a simulator recording.

What a simulator can say:
- **Carries over:** how long our own logic and JavaScript take, and how long an animation is set to run.
- **Doesn't carry over:**
  - GPU cost, including Liquid Glass and blur;
  - frame pacing at 120 Hz (the simulator draws at the Mac's rate);
  - touch-to-screen latency;
  - thermal throttling;
  - launch on real storage;
  - WebKit's content-process memory and the device's memory limits.

#### Speed at 30 and 100 tabs, lists and typing (ranked)

The six-row table above runs at nine tabs. This one widens it: 30 and 100 open tabs, 1,000 archived tabs and 3,000
History visits, typing in search, and opening and scrolling Archive and History. Measured 2026-11-16 on one leased
iPhone 17 Pro Max simulator (iOS 27.0), Expo builds from `build-sim-app` (lab on) beside main's SwiftUI build
(`/tmp/ardia-phone/swiftui-main.app`), the apps alternating round by round, under the perflab lock, rounds started only
below a load of 10. Each figure is a median of the opens in that session; ranges are in brackets.

How the state is made, so both apps hold the same tabs:
- Main's SwiftUI app opens nine local pages (`http://localhost:8777/p1.html` … `p9.html`) so its store and pictures are
  real, then `seed.py` clones its SwiftData rows to N open tabs (cycling the nine pictures), 1,000 archived tabs over 30
  days and 3,000 visits.
- SwiftUI opens that store once, and the Expo build is installed over it, so the upgrade import brings over the same tabs,
  archive, history and pictures.
- Each round restores those saved containers onto a fresh install (`restore_state`), and rewrites the Expo pictures'
  stored paths to the new container (see the note below).

Ranked by how much a person feels it, worst first:

| Rank | Interaction | SwiftUI | Expo before | Expo now | Commit |
|---|---|---|---|---|---|
| 1 | Archive open, 1,000 archived tabs: tap Archive in the deck's ··· menu to the sheet moving | 308 ms (277–337) | 1,354 ms (1,297–1,445) | **409 ms** (358–438) | this commit |
| 1 | Archive open, the same, to settled | 823 ms | 1,880 ms | **927 ms** | this commit |
| 2 | History open, 3,000 visits: tap History in the page menu to the sheet moving | ~800 ms | 963–1,288 ms | 675–790 ms | this commit (level) |
| 3 | History scroll, one flick at a time: frames over 34 ms (frames drawn) | 0.5, worst 34 ms (147) | 19.5, worst 88 ms (106) | **3.5**, worst 54 ms (133) | stepped window and pages |
| 4 | Archive scroll, one flick at a time: frames over 34 ms (frames drawn) | 3, worst 54 ms (140) | 10.5, worst 55 ms (124) | **7.5**, worst 48 ms (128) | stepped window and pages |
| – | Deck scroll, 30 tabs, two 300 ms drags: frames over 34 ms | 4–7, worst 48–58 ms | 0–5, worst 33–57 ms | | level, Expo smoother |
| – | Deck scroll, 100 tabs | 4–6, worst 52–58 ms | 0–3, worst 28–45 ms | | level, Expo smoother |
| – | Deck open, 30 / 100 tabs, motion ends | 205 ms (first movement +38–44 ms after the tap) | about 160 ms, moving in the tap's frame; a faint fade lasts to 237–245 ms | | level |
| – | Card open, 30 / 100 tabs | 171 / 168 ms | 191 / 188 ms | | about a frame slower, as at nine tabs |
| – | Closing a tab by flick, 30 / 100 tabs | 643 / 648 ms to still | 556 / 553 ms | | level |
| – | Cold launch, first frame to settled, 30 / 100 tabs | 409 / 411 ms | 409 / 409 ms | | level (iOS's zoom; see the first table) |
| – | Typing in search, one letter: the letter and the new suggestion rows | same frame | same frame | | level |
| – | Search panel open from a page, to settled, against main at e945077b6 (#2010's growing pill), 2026-11-16 19:18–19:33 | 393 ms (383–557) | 410 ms (382–417) | | level; Expo is the old search motion (JS at 82888f79f on native from 3e5ae048c), not the uncommitted native stage |
| – | Search submitted (Go) to the page's first paint, same session | 143 ms (58–287) | 98 ms (65–367) | | faster; WebKit's own time on the Mac's CPU |
| – | Search submitted to settled, same session | 332 ms (282–530) | 328 ms (263–997) | | level |
| – | Search panel open from a page, tap to settled, against main at e945077b6 with the native stage (e4b1e1739's stage-7), 2026-11-16 21:50, iPhone 18 Pro, still pages on loopback, ten each in alternating rounds, load 4–5 | 537.5 ms (458–558); first movement 150 ms after the tap | **435 ms** (423–540); first movement 54 ms | | faster |
| – | Search submitted (Go) to settled, same session | 315 ms (295–485) | **333 ms** (313–942; two first-of-round outliers) | | level |
| – | Memory after the round (app process only) | 73 MB | 81–93 MB | | Expo +8 to +20 MB |

What was found, and what the fix does (this commit):
- **Archive** spent its open on three things, measured with `sample` on the app process at 1 ms:
  - every day section's `List.ForEach` started with an 11-row window (Expo UI's default overscan of 10), off screen or
    not, so 30 days of archive mounted about 330 rows before the sheet moved; the JavaScript side took 367 ms and the
    main thread 312 ms to mount them;
  - each row built a new date formatter (`toLocaleTimeString`), 83 ms over those rows;
  - presenting the sheet for the first time after a launch: Expo UI's SwiftUI frame (navigation stack, toolbar, list) is
    built then, and a variant bisect put that at about 260 ms on its own against 90 ms for a sheet holding one `Text`.
  The fix: sections that start below the first screenful render one row until they appear, and those sections and the
  Options menu's items wait until the list has appeared; one cached time formatter (`clockTime`); the archive is read
  while the ··· menu is open (`prepareArchive`, iPhone only), and the sheet skips its own read when that one is under
  2 s old; and once a launch, a second after the deck shows, the same SwiftUI frame is built once off screen for 0.7 s,
  so the first real open costs what a second open does.
  Step by step, in the same session (sheet moving, medians): HEAD 1,320 ms; the windows, formatter, staging and the
  prepared read 776 ms; with the warm-up at menu open 352 ms; with it at deck idle, as shipped, 409 ms against main's
  308 ms. What is left, about 100 ms, is the part of the frame build the warm-up doesn't reach.
- **The menu was not the cause.** A probe build timed the native menu's selection, JavaScript receiving it (14–18 ms
  later), the list drawn (82–144 ms) and the sheet's view controller appearing; opening the sheet from a deck script with
  no menu at all showed the same wait. The ··· menu itself still opens in 268–278 ms in both builds: warming while it
  opened delayed it by 150–200 ms, which is why the warm-up runs at deck idle instead and gives up about 60 ms of the 352.
- **History** uses the same day-section windows and formatter, so it gets the first two parts. It is level with main:
  both apps wait for the page menu to close before the sheet rises, about 0.8 s from the tap in main and 0.68–0.79 s in
  Expo. Expo's difference is what happens meanwhile: main closes its menu at once, Expo holds it until the sheet starts.

Scrolling, what was found and what the stepped window and the pages do:
- Three flicks in a row overstate both apps: `agent-device` takes an XCTest accessibility snapshot for each gesture,
  and the next one lands while the last flick is still gliding (873 of 1,963 ms of the main thread in one History
  sample). One flick per recording, 2.2 s apart, keeps it out; the rows above are measured that way.
- What is left is SwiftUI rebuilding the list: whenever Expo UI's row window moves (every row, while scrolling),
  `UpdateCollectionViewListCoordinator` walks every row of every day (`ForEachList.applyNodes`,
  `SectionAccumulator.formResult`), about 3,000 rows in History. The favicon arriving was not it: JavaScript was 61 ms
  of a five-second sample.
- The fix: on iPhone, Metro gives Expo UI's recycling hook `src/lib/steppedWindow.ts` in place of its
  `recycling/window`, which moves the window in steps of the overscan (ten rows) instead of one, so a flick causes a
  tenth of the rebuilds; and both lists show whole days up to 200 rows, adding the next 200 when the last day shown
  appears, so each rebuild walks a few hundred rows instead of thousands. The stepped window alone took History from
  19.5 to 12 long frames a flick; with the pages, 3.5. A 100-row page was worse (8.5): each extension is itself a
  rebuild.
- Archive gained less (10.5 to 7.5); its rows sit in native `Section`s, and what is left there is not yet found.

Left, and the next step for each (2026-11-16, the screens agent took these over from the speed agent):
- Archive and History scroll, re-measured 2026-11-16 21:40 on the iPhone 18 Pro with the lab's `-ArdiaDemoScale 1000`
  (1,004 archived tabs, 3,007 visits over 30 days; the demo seed now writes them, so any leased device can be seeded),
  one 150 ms flick a recording, load 4–8: Archive 5 long frames a flick (4, 5, 7, 5; worst 49 ms), History 4.5 (3, 6, 1,
  12; worst 44 ms). Main wasn't re-measured in this session (its demo seed has a handful of rows); its figures above
  are the speed agent's 3 and 0.5. A `sample` of the app across one History flick found the main thread mostly in the
  test driver's own work: about 39% of it building XCTest's accessibility snapshot for the gesture command
  (`XCTElementSnapshotRequest`, `_accessibilityUserTestingSnapshotWithOptions:`), against about 6% in Core Animation's
  commit and 4% in the list's collection-view layout. So these counts are measured through the driver, and the
  driver's cost grows with the accessibility tree: our History row exposes seven nodes (cell, container, button,
  title, a device badge's container and image, detail) where main's exposes five (cell, container, button, title,
  detail). The next step is a flick that doesn't snapshot (or one timed from the app's own frame callback) to separate
  the list's real long frames from the driver's, before changing the rows; flattening the device badge into the detail
  text, as main's is, would also cut two views a row.
- Archive open, about 100 ms behind main (409 against 308 ms to the sheet moving). What is left is the part of Expo UI's
  first SwiftUI frame build the deck-idle warm-up doesn't reach. The next step is warming the sheet's toolbar and
  search field as well as its list, and timing the ··· menu again, since warming at menu open delayed the menu by
  150–200 ms.

The deck as one piece (`ContainedDeck`, the Android agent's container that moves by one transform) was tried on iPhone
and left off: at 100 tabs, four drags spent 81–117 ms of the main thread in Reanimated worklets with the current deck
and 74–123 ms with the container, and neither dropped a frame on the simulator. The per-card cost that shows on
Android's F4 doesn't show on the Mac's CPU; it needs a real iPhone to decide.

The search rows above are against the SwiftUI reference at e945077b6 (`/Users/shivam-mini/Developer/ardia-phone-references/swiftui-main.app`),
30 open tabs, two rounds each with the apps alternating, five opens and five submits a round to
`http://localhost:8777/p2.html` … `p6.html`. The rest of this table was against the reference at a6ab64311
(`swiftui-main-a6ab64311.app`). `sample` attached to the app stops `simctl io recordVideo` from starting ("Host
recording is already in progress"), so recordings and samples are separate runs.

To watch on the dashboard: `list_sheets_late` in `usage_counts` counts Archive or History sheets whose rows were drawn
more than 400 ms after they were asked for; it should be near zero, and a rise means the open is again doing its
mounting before the sheet moves. `list_pages_added` counts each time a list added its next 200 rows: how often
people scroll that far, which says whether the page size is felt. Smoothness itself can't be counted from the app: the
frames that drop are the main thread's, which JavaScript doesn't see.

Found on the way, not speed:
- The Expo app stores each tab's picture as an absolute `file://` path inside its own data container. That folder's name
  changes when the app is reinstalled or restored from a backup, and the deck then shows placeholder faces for every
  tab. Storing the file name and resolving it against the container at read time would survive that.
- The upgrade import refused a SwiftData store with no `-wal` file beside it ("Couldn't Bring Over Your Tabs"). A store
  main's app has opened always has one, so only a store written by a tool hits it.

What a simulator can't show here: the 120 Hz pacing of the list scrolls, touch-to-screen delay, and how much slower a
phone's CPU makes Expo UI's frame build; the Archive's 260 ms frame on the Mac's CPU could be several times that on the
oldest iPhone that runs iOS 27.

Traps for anyone repeating this:
- A Simlock lease ends after about an hour (13:30, 14:32, 15:34, 16:37 here) whatever the load; its `agent-device` then
  says "too old to use through a gateway". Lease again; it comes back as the same, wiped simulator.
- A background job started from the Bash tool stops after two hours, the local page server with it.
- `xctrace` can't see Simlock's device set; `sample <pid>` on the simulator's app process works and is symbolised.

#### Measuring speed on a real iPhone

What it needs, for a yes or no:

1. **The build.** A development-signed Release build of the Expo app, made with Xcode from `apps/phone/ios/Ardia.xcworkspace` (Release, a device destination).
   - Development signing keeps it debuggable, so Instruments can profile it. A TestFlight build can't be profiled that way.
   - It can't sit beside the TestFlight SwiftUI app as things are: both are `com.ardia.browser.ios`, with extensions `com.ardia.browser.ios.share`, `.open` and `.widgets`, and the app group `group.com.ardia.browser.ios`. Installing it replaces the SwiftUI app and its data on that phone.
   - The cleaner way is a second bundle id for measurement only: `com.ardia.browser.ios.measure`, built without the three extensions and the app group. Then both apps sit side by side and nothing of the owner's is touched. That's a build-setting change on our side, plus the signing below.
2. **The signing,** all the owner's to do (agents never touch the Apple developer account, certificates, profiles or the device list).
   - Register the phone's UDID in team U5L5T3NGVV's devices, or let Xcode do it while signed in as a team member with automatic signing, which is what the projects use (`CODE_SIGN_STYLE = Automatic`).
   - Let Xcode create a development certificate and profile for the bundle id. For the measurement id, that means an App ID `com.ardia.browser.ios.measure`, with no capabilities beyond the defaults if it's built without the app group.
   - On the phone, turn on Developer Mode (Settings › Privacy & Security › Developer Mode) and trust the Mac.
3. **The devices.**
   - The oldest iPhone that runs iOS 27 (the deployment target is iOS 27.0 in both apps). It shows the worst case for JavaScript, glass and memory.
   - A current one, with 120 Hz ProMotion, for frame pacing.
   - Which phones he has is his to say.
4. **The Mac.** This Mac, with Xcode 27.1, over a cable for the first pairing, then over the same network.
5. **The tools.**
   - Instruments' **App Launch** template (or `xcrun xctrace record --template 'App Launch' --device <udid> --launch -- com.ardia.browser.ios.measure`) for cold and warm launch.
   - **Animation Hitches** for the deck, the card opening, the tab swipe and scrolling: hitch time ratio and long frames, at 120 Hz.
   - **Time Profiler** for where JavaScript and native time goes.
   - **Allocations** and the VM Tracker for memory, with the WebKit processes counted.
   - Touch-to-screen latency: the phone's own screen recording at 60 fps shows the result but not the touch. A 240 fps slow-motion film of the phone, taken with another phone, shows both the finger and the frame.
   - MetricKit isn't needed for this: it reports field data a day later, from users' phones.
6. **What only a device can settle:**
   - launch time on real storage;
   - touch-to-screen latency, and the back and forward edge swipes;
   - the deck's and the bar's glass and blur cost and hitches at 120 Hz;
   - memory pressure and the WebKit processes;
   - heat over a long session;
   - energy.

   The simulator rows above settle only how long our own work and animations take, and app size.

#### Default browser on iPhone

Apple granted the web-browser entitlement (`com.apple.developer.web-browser`) for `com.ardia.browser.ios`, so the
app ships with the default browser on, and one build setting turns all of it on or off together:

- **The switch.** `ARDIA_DEFAULT_BROWSER = YES` in the Debug and Release settings of the Ardia target in
  `apps/phone/ios/Ardia.xcodeproj/project.pbxproj`. `release-ios` signs with it unless `--no-default-browser`, and
  the iOS Release workflow's `default_browser` input is on by default.
- **The entitlement.** `CODE_SIGN_ENTITLEMENTS = $(ARDIA_ENTITLEMENTS_$(ARDIA_DEFAULT_BROWSER))`, so `NO` signs with
  `apps/phone/ios/Config/Ardia.entitlements` and `YES` with `apps/phone/ios/Config/Ardia-DefaultBrowser.entitlements`,
  the same file plus `com.apple.developer.web-browser`. Main's SwiftUI app signs with the same two files.
- **Info.plist.** `ArdiaDefaultBrowser` is `$(ARDIA_DEFAULT_BROWSER)`, which ArdiaKit's
  `DefaultBrowserStatus.isOffered` reads. The http and https `CFBundleURLTypes` iOS requires of a default browser are
  already declared and do nothing until the system lists Ardia.
- **What appears.** With `isOffered` true, `ArdiaPhoneDefaultBrowser.status()` returns `canAsk: true`: the
  onboarding step shows (unless asked within 100 days, as in SwiftUI), and Settings › Default Browser opens the
  system's Default Apps page. Page menu › Open in Default Browser hides once Ardia is the default. With `NO`,
  `isDefault` and `canAsk` are both false and none of this shows.
- **The signing side.** The App ID `com.ardia.browser.ios` has the Default Web Browser capability, switched on under
  Additional Capabilities in the developer portal after Apple's approval; automatic signing puts it in the profile.
  Without it a build with `YES` fails to sign ("requires approval from Apple"), so it cannot ship half on.

`apps/phone/src/dev/defaultBrowserSwitch.test.ts` keeps this true: every configuration says `YES`, the entitlement and
the Info.plist key come from that one setting, and the two entitlement files differ only by the web-browser key.

#### Settings on Expo UI: main's SwiftUI screens, the checklist

The Expo UI Settings is compared against main's SwiftUI Settings (`apps/ios/App/Settings/`, read at 654d6396f),
screen by screen and row by row. Every row below names the SwiftUI main uses, so the Expo UI screen uses the same
view or our extension of it. Icon rows are `SettingsRowLabel(title, systemImage:, tint:)`: a `Label` whose icon is
`SettingsIconTile`; tints are `SettingsTint` (ArdiaDesign `SettingsTokens.swift`).

Whole stack (`SettingsView.swift`):
- `NavigationStack(path:)` with `navigationDestination(for: SettingsRoute)`; title "Settings", inline; toolbar
  `ToolbarItem(.confirmationAction)` "Done", semibold.
- `.tint(Palette.formAccent)` (#007AFF light, #0A84FF dark) and `.toggleStyle(SettingsSwitchStyle())`: a switch
  tinted `systemGreen`.
- Every page gets `.settingsChrome()`: `scrollContentBackground(.hidden)` over `SettingsSurface.page` (the system's
  grouped background), `scrollEdgeEffectStyle(.hard, for: .top)`, and the navigation bar's background the same
  colour, always visible. Main draws the space's window tint here (`ProfileBackdrop`, `look.surface`); see
  "Deliberately different".
- Pages with a hero use `.settingsPage(title)`: the inline title stays empty until the content scrolls past 150 pt
  (`onScrollGeometryChange`).
- Lists are `Form` with `.contentMargins(.top, Spacing.small)` (12 pt).
- Presentation: main uses a plain `.sheet(item:)` from `RootView`, with no presentation modifiers. On iPhone ours is
  Expo UI's `BottomSheet` with none either (`ExpoSettingsSheet`): system detent, corners, drag to dismiss and
  scaled-back page; Done and a drag both close Settings through `onIsPresentedChange`.
- Rule: a toolkit screen is hosted in a container the system positions, never inside a view we animate by
  transform, because SwiftUI records its accessibility frames at layout time and never updates them after our slide.
- Every toolkit screen's simulator pass reads three elements' frames from the accessibility tree (`snapshot --json`)
  and compares them with where the screenshot draws them.

Root (`SettingsRootList`), sections in order. Main's SwiftUI order was: Sync row, shortcuts, Appearance alone, Site
Settings with Default Browser, the three search rows, then one mixed group (Archive Inactive Tabs, Open App Links In,
Clear Browsing Data, Export Open Tabs), Experimental, usage sharing, Show Onboarding with About. The Expo app's root
was regrouped after build 13 (the owner: group them sensibly, as iOS Settings and Safari do, Experimental and About at
the bottom, no group holding one unrelated row). Every row is kept with its name, icon and tint; only the grouping,
the order and the section titles changed (`ExpoSettingsRoot.tsx`). Android's Settings (`SettingsRoot.tsx`) keeps
main's order for now.
1. Sync row: `NavigationLink` to Sync; `SettingsIconTile("macbook.and.iphone", sync blue, baseSide 56)` (44 at
   accessibility sizes, stacked) beside a headline title and a subheadline secondary status (`.contentTransition(.opacity)`),
   6 pt vertical padding, one accessibility element. First, as iOS Settings puts the account first: it is the one
   card with a status line.
2. Shortcuts: two capsule buttons, "Archive" and "Spaces", side by side 12 pt apart (stacked at accessibility
   sizes): body medium, full width, min height 48, `secondarySystemGroupedBackground` capsule, `PressableStyle`
   (scale 0.94 pressed, `Motion.press` spring 0.16/1). Row background clear, zero insets, section spacing 12.
   They leave Settings for a sheet, so they stay above the settings proper.
3. "General": Appearance (`NavigationLink` + `LabeledContent`, value the summary, e.g. "Match My Mac" or "Blue,
   Glass, Dark"; "paintpalette.fill" in the profile's swatch colour), "Site Settings" ("globe", neutral #86888D),
   "Default Browser" ("safari.fill", #007AFF, only when `DefaultBrowserStatus.isOffered`) and `Picker` "Open App Links
   In" ("arrow.up.forward.app.fill", #3EA82E). How browsing looks and behaves everywhere: Appearance is the most
   visited page, Site Settings holds blocking, Night Shade, swipes and the bar, and where links open sits with the
   default browser. It replaces Appearance's one-row group and Site Settings' two-row one.
4. "Search": "Search Engine" (`LabeledContent` with the engine's name, "magnifyingglass", #007AFF), `Toggle` "Search
   Suggestions" ("text.magnifyingglass", #458AFF), `Toggle` "Auto-Open Keyboard" ("keyboard.fill", #FFC829). Safari's
   first group; unchanged rows, now titled.
5. "Tabs": `Picker` "Archive Inactive Tabs" ("archivebox.fill", #B059EE, menu picker tinted secondary) and "Export
   Open Tabs" ("square.and.arrow.up.fill", #0153FF: a `ShareLink` of the open tabs' addresses, or a toast when there
   are none). Safari's Tabs group; both act on the open tabs.
6. "Privacy": "Clear Browsing Data" ("eraser.fill", #FF5A5F), `Toggle` "Share anonymous usage stats"
   ("checkmark.shield", neutral) and "What's Sent" ("info", neutral), with no footer (the owner after build 13: the
   sharing summary under it is gone; What's Sent and the opt-in say it). What the app keeps and what it sends,
   together; Clear Browsing Data used to sit in the mixed group. Android's Settings keeps the summary.
7. "Experimental": "Browse for Me" when offered. Rarely changed, so near the bottom.
8. "About": "Show Onboarding" button ("hand.wave.fill", #FF901A, tinted primary) and "About Ardia" link ("info",
   neutral). Footer: the version line, centred, 16 pt above. Last, as iOS Settings ends with About.

Appearance (`AppearancePage.swift`, `ColorChoiceRows.swift`):
- Colour: the word "Color" over nine swatches in one row (`ColorSwatch`: 26 pt circle, a 2 pt ring 3 pt out when
  chosen, 44 pt hit height, `Motion.snappy` spring 0.2/1), then a `Toggle` "Match My Mac" when sync is on.
  The Expo app shows the nine presets and a tenth swatch, Custom, in two rows of five (2026-11-22). See "Custom theme"
  below.
- "Interface Style" section: `CheckmarkRow`s Match My Mac, Glass, Classic (a semibold checkmark in `formAccent`,
  the row a plain `Button` tinted primary, `.isSelected` trait). Footer: "Match My Mac follows your Mac. Reduce
  Transparency in iOS Settings always uses Classic."
- "Light or Dark" section: `CheckmarkRow`s Match My Mac, System, Light, Dark. Footer: "Match My Mac follows your Mac.
  System follows this device."

Custom theme (the Mac's custom profile theme on the phone, 2026-11-22):
- Settings › Appearance has a Custom swatch after the presets on iPhone and in the hand-built Settings Android keeps.
  It is not offered in Android's Material design, which takes its colours from Material You and doesn't draw the
  look. The swatch shows the saved theme's colours, or a hue wheel before there is one. Choosing it sets
  `colorChoice` to `custom`. If no theme is saved yet, it saves one first: the Mac's full theme when Match My Mac was
  showing one, otherwise the Mac's `startingTheme` seeded from the current look's swatch. Then it opens the Theme
  page. While Custom is chosen, an "Edit Theme" row under the swatches opens the page again. Choosing a preset keeps
  the saved theme, so Custom brings it back. Turning Match My Mac off while the Mac shows a full theme copies that
  theme into Custom.
- The Theme page (`components/settings/ThemePage.tsx`, `ThemeControls.tsx`, route `theme`) follows the Mac's
  `ThemeEditor.tsx` and the native port on d3fc4c02c. It has a preview of the shown look, the colour pad (hue around,
  saturation outward, 1 to 3 knobs, tap a knob to select it, tap elsewhere to move the selected one), a brightness
  bar for the selected colour, "N of 3 colors" with − and +, and Intensity, Pass-Through Blur and Noise sliders.
  Texture is a menu row (Grain, Sand, Denim, Tweed); picking one while Noise is 0 sets Noise to 0.5. Direction is a
  dial: drag to turn, 45° notches within 4°, and it shows degrees. Appearance is a menu row (Light, Dark, Match
  System). Gestures are gesture-handler pans that keep the page from scrolling under them. Edits show live,
  coalesced to one draft per frame (`state/settings/themeDraft.ts`). They are saved on release
  (`editCustomTheme`).
- Storage: `settings.customTheme` in the preferences table, the Mac's `ProfileTheme` as JSON, sanitized on read
  with the Mac's `sanitizeTheme`. It stays on the phone and is never written to sync.
- The maths is the Mac's own, shared rather than copied: `packages/core/src/theme.ts` holds `startingTheme`,
  `sanitizeTheme`, `themeArea`, the layer, underlay and grain alphas, `TEXTURE_STRENGTH`, `readableDark` and
  `shownLook`. The Mac's `apps/browser/src/lib/profileLook.ts` re-exports them. The phone's `lib/profileLook.ts`
  gives a `ProfileLook` a `custom` theme with its source: `own` for the phone's theme, so its mode decides, and
  `app` for Match My Mac, which follows the app's light or dark as the Mac's "Profile themes follow this
  appearance" does by default. The sync view's `theme.look`, `theme.dark` and `theme.mode` feed `app`. A view
  without them still draws the colours as before.
- Light or dark: `themedScheme` puts the theme's choice on top of Settings › Light or Dark. A theme's own Light or
  Dark wins. A look whose ink isn't readable keeps the other appearance (`readableDark`, the Mac's 3:1 and 2:1), and
  the page then says "Kept dark (light) so text stays readable". Match System keeps the app's choice. The override
  goes to the window through `overrideColorScheme`.
- Drawing: every look view that takes the look's colours (`ProfileBackdrop`, `DeckBackdrop`, `Frost`, `Glass`)
  also gets `themeLook`. This is the look resolved for the view's light or dark (`themeLookFor`): stops as 0 to 1
  floats with their pad places, intensity, grain, texture, translucency and angle. Native draws the Mac's
  composite when it is set. `color`, `themeColors` and `darkThemeColors` keep the stops' hex for views that only
  tint. In the redesign's start page, a custom look draws a themed `ProfileBackdrop` (`CustomLookBackdrop`) in place
  of the CSS gradient. The widgets get the theme's accent hex as their colour.
- Demo launches: `-ArdiaColor custom` (demo or lab) chooses Custom. With no saved theme it saves the native port's
  demo theme: three colours, intensity 0.8, Sand noise at 0.7, blur 0.5 and 225°. `-ArdiaSettingsPage theme` opens
  the editor.

Site Settings (`SiteSettingsPage.swift`):
- From the page menu's Site Settings it opens as the Settings sheet's first page (`openSettingsPage`, the
  `openSiteSettingsSheet` action), so it has Settings' sheet, inline title, Done button, 12 pt list top and grouped
  colours in light and dark; it used to open as a page pushed onto Settings, with a back chevron and no Done
  (build 13, the owner: the site settings popup should look and behave like Settings). From Settings › General it is
  still a pushed page. `ExpoSettingsDone` is the one Done toolbar both use. Watch `site_permissions_revoked`.
- Toggles "Block Ads" ("hand.raised.fill", #FF5A5F), "Block Trackers" ("eyeglasses", #FFC829), "Block Cookie
  Banners" ("list.bullet.rectangle.portrait.fill", #FF901A); links "Filter Lists" (`LabeledContent` count,
  "line.3.horizontal.decrease", neutral) and "Trusted Sites" (count, "checkmark.shield.fill", #3EA82E).
- Pickers "Night Shade" ("moon.fill", #5856D6) and "Swipe to Navigate" ("hand.draw.fill", #458AFF); toggle "Collapse
  Bottom Bar" ("platter.filled.bottom.and.arrow.down.iphone", #30B0C7). Footer: "Change one site from its page menu."
- "Camera, Microphone and Location": allowed sites, "None" when empty, `.swipeActions` "Revoke" (destructive), and a
  `confirmationDialog` titled with the host listing "Revoke <permission>" per kind. Footer about private tabs.

Sync With Mac (`SyncSettingsPage.swift`): `SettingsHero` (tile 64, title2 bold, subheadline secondary, clear row) with
"Connect to Your Mac" when not connected; "What You Get" section; an attention section ("Choose Folder…" or
Connect Again); Devices list with `ProgressView`; "This iPhone's Name" `TextField`; "Sync Folder" `LabeledContent` +
"Change Folder…"; destructive "Stop Syncing…" with a `ProgressView`, confirmed by `confirmationDialog` "Stop Syncing
This Device?".

Connect to Your Mac (`SyncConnectPage.swift`): `SettingsHero`; "Two Steps" section of two `SetupStepRow`s (26 pt
numbered badge: green check when done, `formAccent` when current, tertiary fill when later; `Motion.snappy`), with
"Scan Code" and "Enter Words" buttons and a "Connecting…" `ProgressView`; footer about the Keychain. Recovery phrase
entry: a multiline `TextField`, a check line in `.ink(.green)` (`LegibleInk`, contrast 4.5:1 or 7:1), toolbar "Use
Phrase". The code scanner is a full-screen camera page, not a list.

Search Engine: a "From Your Mac" `LabeledContent` with footer "Set on your Mac." when synced, else a list of engines
with checkmarks.

Filter Lists: `SettingsHero`; lists with `Toggle`s and `ProgressView` while updating, footer "Checked weekly.";
"Add a List…" (a sheet with a URL `TextField`, Cancel and Add) and "My Filters" (`LabeledContent`); destructive
"Restore Defaults…" confirmed by a `confirmationDialog`. List detail: `Toggle` "Use This List", status rows as
`LabeledContent`, "Source" `Link`s, destructive "Remove List…" confirmed by "Remove This List?". My Filters: a
`TextEditor` with toolbar Revert and Apply and a "Filter Syntax" `Link`. Trusted Sites: a list with `.onDelete` and
an `EditButton`.

Clear Browsing Data: a "Time Range" `Picker`; "Clear" section of `Toggle`s History, Cache, Cookies and Site Data,
Archived Tabs; destructive "Clear Data…" with a `ProgressView`, confirmed by a `confirmationDialog`.

Default Browser: an explanation page with "How to change your default browser" and an "Open Ardia in Settings"
button. About: `AppIconPreview` (72 pt, 22.5% continuous corners, a 0.5 pt hairline) and "Ardia", three `Link` rows
(ardia.dev, Release Notes, Source Code), a footer, "Open Source Licenses" (each credit a `LabeledContent` and a
`Link`).

What Expo UI doesn't have and we add through its extension path (`ExpoUIView` views and
`ViewModifierRegistry` modifiers in a module that depends on `ExpoUI`), taken from ArdiaDesign so both apps share one
source:
- Views: `SettingsIconTile` (already public in ArdiaDesign), `SettingsRowLabel`, `SettingsHero`, `SetupStepRow`,
  `ColorSwatch` row, `CheckmarkRow`, `AppIconPreview`, `ProfileBackdrop`.
- Modifiers: `settingsChrome`, `settingsPage(title)`, `chromeSurface(in:interactive:tinted:)` (glass
  `.regular`/`.interactive()`, or Classic: `look.surface` or the background with a 0.5 pt stroke at 12%),
  `SettingsSwitchStyle`, `PressableStyle`, the `LegibleInk` text style.
- Tokens as values: `SettingsTint`, `Palette.formAccent`, `Spacing` (4, 8, 12, 16, 20, 24, 32), `Motion.press` and
  `Motion.snappy`.
- The app-only pieces live in ArdiaDesign. `packages/phone/ios/ArdiaKit/Sources/ArdiaDesign/SettingsPieces.swift`
  holds public `SettingsRowLabel`, `SettingsHero` (built on `SettingsHeroContent`), `SetupStepRow`, `CheckmarkRow`
  (built on `CheckmarkLabel`), `ColorSwatch`, `AppIconPreview`, `PressableStyle`, `LegibleInk` and
  `SettingsSwitchStyle`, for the Expo screens; `SettingsTint.named(_:)` in `SettingsTokens.swift` maps the token
  names. With the SwiftUI app gone from this branch they are the only source: change them there. Main's SwiftUI app
  has its own copies (`App/Settings/SettingsComponents.swift` and others), which shadowed the package's types while
  both lived here, so the extension members are named `ardiaSettingsChrome()`, `ardiaSettingsPage(_:)` and
  `.ardiaInk(_:)`.
- The Expo side: `packages/phone/ios/SettingsUIModule.swift` (`ArdiaPhoneSettingsUI`: the `ExpoUIView` views and the
  `ardia.*` modifiers registered in `OnCreate`) and `packages/phone/src/settingsUI.tsx` (one API for both phones;
  without the native module the views draw nothing and the modifiers are null).

The Expo app keeps one row main has no counterpart for: What's Sent (opt-in usage stats, the owner's approval).

Each Expo UI screen is checked against main's as it lands: the same rows in the same order, positions and sizes
from captures at the same scroll, type and colours light and dark, the push and pop between pages in 60 fps frames,
and scroll speed on the root list.

#### The Expo app on TestFlight, internal group first

This section records the switch from SwiftUI to Expo. The current TestFlight and USB commands are below.

**A commit is uploadable only after a CI dry run at that exact commit** (`ios-release.yml`, `mode=dry-run`). A local `release-ios` run proves the build, not the tree CI sees: CI runs `pnpm install` and `pod install`
fresh, and its dependencies step now fails, showing the diff, when `pod install` rewrites anything under
`apps/phone/ios`. Run 43861288422 stopped on exactly that: 042a23ace had added a build file to the project by hand
out of the id order CocoaPods writes in (fixed in 8304ed5c6, and on `expo-ios-internal-0.2.47-nightly.4` as
d5fbaabc1). After a hand edit to the project, run `pod install` and commit what it writes.

**What the build is.**
- **App record:** the same as the SwiftUI app: "Ardia", bundle id `com.ardia.browser.ios`, team `U5L5T3NGVV`, and the
  extensions `.share`, `.widgets` and `.open`. The Expo project (`apps/phone/ios/Ardia.xcodeproj`) already uses these
  ids and the same entitlement files, now in `apps/phone/ios/Config`: the app group `group.com.ardia.browser.ios`, and the default
  browser off (`ARDIA_DEFAULT_BROWSER = NO`).
- **Version and build number:**
  - The Apple version is TestFlight's pin, `1.0.1` for now ("TestFlight: the workflow, its certificate and its
    testers" below). Until 2026-11-19 it was the Mac's release version.
  - The build number goes above the highest one App Store Connect holds. On 15 Nov that is 0.2.47 (9), uploaded that
    day, internal "in testing", external "waiting for review" (`gh workflow run ios-release.yml -f mode=status`).
  - The first Expo candidate at the time was 0.2.47 (10) or later.
  - The project's committed 0.1.0 (1) is set at archive time on all four targets, as main's `scripts/release-ios.sh` does. It
    is never committed.
- **The release path** (9ac589838, 6dfe58539):
  - `apps/phone/scripts/release-ios <build> --version <release> [--unsigned | --no-upload]` is the Expo counterpart
    of main's `scripts/release-ios.sh`. It archives `apps/phone/ios/Ardia.xcworkspace` for a device in Release, with the
    release version on every target and `ArdiaReleaseVersion` in the app.
  - The commit's JavaScript is compiled with Hermes with the lab off, handed to the bundle phase through
    `ARDIA_PREBUILT_BUNDLE`, and stamped.
  - It refuses an uncommitted native tree or Pods behind `Podfile.lock`.
  - It checks the versions and build on all four targets, the three extensions, the stamp, Hermes bytecode, the test
    hooks off, the stripped frameworks, the app's dSYM matching its binary, default browser off and, when signed, the
    app group and web-browser entitlements.
  - The Settings footer follows main's `AppVersionLabel`: "Ardia 0.2.47 Nightly 2 (10)" from TestFlight.
  - `.github/workflows/ios-release.yml` builds it, the only iPhone app since the clean-up. It installs the app's
    packages and Pods on the `xcode-27` runner and runs that script. An upload with `public_testers` on is refused,
    so it can only reach the Internal group.
  - **On a cable** (main's 2c6b7fae4 and 218f50ee4, carried over to the Expo path). `-f mode=device -f udid=<udid>`
    registers that iPhone on the team (`xcrun devicectl list devices` shows the UDID; `asc.mjs register-device` leaves
    one already there as it is) and uploads a development-signed `ios-device-build` .ipa, built from the ref the run
    starts on by `release-ios --development`. It uploads nothing to App Store Connect and takes no build number, so
    trying a branch on a phone spends no TestFlight build. Use the device install steps below. The job masks the UDID
    before any step's environment is printed.
- **Proved without the Apple account** (2026-11-16): `release-ios 10 --version 0.2.47 --unsigned` on this Mac.
  - Every check passed, at 56.5 MB installed.
  - Every target reads 0.2.47 (10). The stamp gives JS 9ac589838, dirty no, native clean.
  - The dSYMs for the app, its extensions and ExpoModulesJSI are kept. The strip phase ran.
- **What is left to press, in order. None of it is an agent's to do on its own:**
  1. **Push this branch** (`git push origin t3/unify-expo-architecture`). GitHub holds e508d5cc5, without the release
     path. Or merge the branch into `main`.
  2. **A CI dry run**, which signs the archive with the team's stored certificate and sends nothing to App Store
     Connect: `gh workflow run
     ios-release.yml --ref t3/unify-expo-architecture -f mode=dry-run`.
     - It runs from the branch: `ios-release.yml` exists on `main`, so it can be dispatched, and the run uses the
       branch's copy.
     - It needs the repository secrets main's SwiftUI path used: `NOTARY_KEY_P8`, `NOTARY_KEY_ID` and `NOTARY_ISSUER`
       (the App Store Connect key), and `IOS_DEVELOPMENT_P12` with `IOS_DEVELOPMENT_P12_PASSWORD` (the development
       certificate).
     - It runs on GitHub's `xcode-27` runner, with Xcode 27.1 and CocoaPods.
     - It is the first time this project signs with the team's identity. Automatic signing for the same four bundle
       ids as main's app should reuse their profiles. The run's logs show it.
  3. **The upload, the owner's moment:** `gh workflow run ios-release.yml --ref t3/unify-expo-architecture -f
     mode=upload -f public_testers=false`.
     - The build number is taken above App Store Connect's highest, from 10 on, unless `-f build=` sets it.
     - The version is TestFlight's pin, `1.0.1`; the run refuses any other.
  4. **On the owner's phone:** install it from TestFlight over the SwiftUI app. Settings' footer should read "Ardia
     <version> Nightly (<build>)".
- **Who uploads, and how 0.2.47 (9) went up:**
  - The SwiftUI build was sent from `main` by the iOS Release workflow on 15 Nov (`gh workflow run ios-release.yml -f
    mode=upload`). The workflow archives, signs with the stored development certificate, and uploads with the App
    Store Connect API key the Mac release notarizes with (`NOTARY_KEY_P8`, `NOTARY_KEY_ID`, `NOTARY_ISSUER`). Then,
    because `public_testers` defaulted to true then, it submits the build to Public Testers for Beta App Review.
  - The Expo build goes the same way with `-f public_testers=false`, so it reaches only the Internal group. That
    means the owner and the team's App Store Connect users.
  - The workflow runs from the branch that holds the Expo release path (`--ref`), or from `main` once it is merged.
  - On a Mac, `apps/phone/scripts/release-ios` does the same with the account Xcode is signed in to, or with `ASC_KEY`,
    `ASC_KEY_ID` and `ASC_ISSUER`.
- **On the owner's phone:**
  - TestFlight installs the Expo build over the SwiftUI app, the same bundle id with a higher build, so the app's
    container, Keychain and app group stay.
  - At first launch the Expo app imports the SwiftUI store once, through the legacy gate. The import covers tabs,
    saved states, the Archive, thumbnails, history and settings, in one transaction, with a receipt.
  - It keeps sync without reconnecting: the recovery phrase in the shared Keychain, and the folder's bookmark.
  - It leaves the SwiftUI store untouched. So installing an earlier build from TestFlight goes back to the SwiftUI app
    with its data, minus anything done since in the Expo app.

**When the Expo app replaces the SwiftUI app for public testers.** The owner has agreed, with no further OK, once
three things hold and the coordinator's report shows them:
1. The iPhone speed table is level with main's app ("Speed against the SwiftUI app").
2. The upgrade from the SwiftUI app passes on a copy of real data (below).
3. The build has been in the Internal group first.

After that the next upload goes with `public_testers` on, or `-f mode=public-link -f build=<n>` sends the internal
build.

**Proving the upgrade on a copy of real data.** On a leased simulator, never the owner's phone or live profile.
1. **Where real data comes from.**
   - A TestFlight app's container can't be read from a Mac. So the source is the owner's Mac Ardia profile, copied
     into a scratch folder (the repo's rule: copies only, never the live profile, nothing written back).
   - Delete `sync.json` from the copy before anything starts, so the copy never syncs to the owner's real iCloud
     folder.
   - `apps/phone/scripts/phone-sync-mac.mjs start` then runs a hidden Debug instance on that copy (its data folder in
     `<work>/mac`, which needs a `--seed <copy>` option added to the script). It turns sync on against
     `<work>/folder`, so the phone side gets the owner's real spaces, pinned tabs and open tabs from a Mac that
     isn't his.
2. **Set up main's SwiftUI app as the owner uses it** (`/tmp/ardia-phone/swiftui-main.app`, onboarding done):
   - Connect: Settings › Sync With Mac › Connect to Your Mac, Enter Words, with the phrase read from
     `<work>/phrase.txt` straight into the field (never printed, no screenshot while it shows). Then the folder:
     `<work>/folder` mirrored into the app's `Documents/Ardia Sync` and chosen there.
   - Then use it: at least nine tabs, two archived, about 30 pages visited, a private tab, every Settings row moved
     off its default, Site Settings, blocking (a trusted site, a My Filters line, one list off), the Reader's
     settings, and Appearance.
3. **Write down "before":**
   - screenshots of the deck, the Archive, History, every Settings page and Sync With Mac;
   - `mac sync`, which lists the phone's device id, name and tabs;
   - the Keychain and folder state as the Sync page shows them.
4. **Upgrade:** install the Expo build over it, the same bundle id with the container kept, as
   `ios-update-launch-check` does, and launch it. The import logs one `ardia-legacy imported …` line with counts per
   kind and no rejects beyond `notWeb` and `duplicate`.
5. **Compare "after" with "before":**
   - the same open tabs in the same order with the same tab selected, and the Archive's count;
   - an old visit found in History and in search;
   - every Settings, Site Settings, blocking, Reader and Appearance value;
   - each tab's back history (go back once).
6. **"No second connect", as it shows:**
   - Sync With Mac opens straight onto the connected page: the device list with the Mac, "This iPhone's Name"
     unchanged, the folder's name;
   - no "Connect to Your Mac" hero or step, and no attention section ("Choose Folder…", Connect Again);
   - `mac sync` lists exactly one iPhone, with the same device id as before, not a second device;
   - a tab sent from the Mac arrives once, and a page opened on the phone appears under its tabs on the Mac.
7. **Kill and relaunch twice:** no second import line, the same counts, still connected.
8. **Clean up:** `mac stop` deletes the scratch Mac and its folder; release the lease; delete the copy of the profile.

**How the simulator half is wired** (worked out on the stand-in run, 2026-11-16):
- **One folder for both sides, no relay.** The leased simulator's "On My iPhone" is the `File Provider Storage` of
  its `group.com.apple.FileProvider.LocalStorage` app group container under
  `~/.simlock/devices/ios/<udid>/data/Containers/Shared/AppGroup/` (read each container's
  `.com.apple.mobile_container_manager.metadata.plist` for `MCMMetadataIdentifier`). Make `Ardia Sync` there, and
  before `mac start` make `<work>/folder` a symlink to it. The Mac writes into it, and the phone's picker shows it as
  On My iPhone › Ardia Sync.
- **The phrase without a screen read:** on Enter Words, take one snapshot while the field is empty, to get the
  field's ref and the Use Phrase button. Then `<agent-device> fill <field ref> --text-stdin < <work>/phrase.txt`,
  which keeps the words out of argv and output, and press Use Phrase by its coordinates. Read the screen again only
  once it shows "Step 1, done".
- **The folder:** Choose Folder… › Browse › On My iPhone › Ardia Sync, then Open from inside the folder.
- **Main's app must be the ad hoc build** (the simulator section above). A `CODE_SIGNING_ALLOWED=NO` build connects
  but can't save the key.
- **Expect Appearance to change once connected:** Match My Mac follows the Mac profile, so a profile set to dark turns
  the phone dark.

**The stand-in run (not the proof).** The owner's profile isn't on this Mac, and copying it is his to allow. So the
tooling ran on a stand-in made through the app: `/tmp/ardia-phone-seed/standin-profile`, with its counts and recipe
in `MANIFEST.md` beside it. It has 4 spaces with 40 tabs, 7 pins, a pinned folder, a split, 613 URLs and 3,025 visits
over 79 days, ten settings off their defaults, and its own test sync identity. Chrome expires visits after 90 days,
so no real profile holds more history than that. How far it got:
- `mac start --seed` dropped the copy's `sync.json`, sync state and old key (1c83ccd5d) and came up with a new
  device id, the 40 tabs, and sync on against the linked folder.
- Main's app, the ad hoc build, onboarded and connected through the steps above. `mac sync` listed one `iPhone` phone
  device, and the phone listed the Mac "shiv" with "Updated just now". Appearance turned dark from the Mac's
  setting.
- The first attempt lost its simulator to Simlock under load, and the second to a double lease (the screens agent's
  install wiped main's app). The third ran to the end on lease f04ed0f4 (udid 97D6E59E), 2026-11-16 04:17–04:44.
  Evidence, with both stores, the Preferences plist, screenshots, trees and `mac sync` output:
  `/tmp/ardia-phone-shots/iphone-standin-upgrade/`.

**A fresh connect on 0.88** (2026-11-16, the Expo build at cb2876bc7, clean install on lease cfc7a246, a scratch Mac
seeded from the stand-in). Onboarding's Connect to Your Mac took the phrase (Enter Words, `fill --text-stdin`) and On My
iPhone › Ardia Sync, and showed "Connected." The Mac listed one new phone (ci7pa7gk…). A tab sent from the Mac arrived
once, marked from "shiv". A page opened on the phone appeared under its tabs on the Mac within one sync.

**The stand-in run's before and after** (the real run reads the same things the same way):

| Check | Before: main's SwiftUI app | After: the Expo build (a987eb84b) |
| --- | --- | --- |
| Open tabs, in order | 21, from `ZBROWSERTAB` in the app group's `Browser.store` | the same 21 URLs in the same order (`tabs` in `Documents/SQLite/browser.db`, diffed) |
| Archive | 2 (Hacker News, Pride and Prejudice) | the same 2 |
| History | 23 visits | the same 23 URLs (`visits`, diffed) |
| Saved page state | 20 tabs with interaction state | 23 `tab_state` rows |
| Settings | Search Suggestions off, Auto-Open Keyboard off, archive after 7 days, app links in App, Appearance Green and Classic with Match My Mac off | the same, in `preferences`; Settings reads the same rows |
| Synced from the Mac | Search Engine DuckDuckGo, the Personal space's pins | the same pins on the start page, four spaces |
| Import | none | `legacy.receipt` `{"tabs":21,"archive":2,"visits":23,"preferences":7}`, all records accounted for |
| Sync With Mac | connected: Mac "shiv", "This iPhone", folder Ardia Sync | opens on the connected page with the same devices and folder; no Connect step |
| The Mac's view (`mac sync`) | one phone, ckl2z6gj…, 21 tabs | the same one phone, the same id, 21 tabs |
| Mac to phone | | a tab sent from the Mac arrived once, marked from "shiv" |
| Phone to Mac | | a page opened on the phone appeared under its tabs on the Mac |
| Kill and relaunch twice | | the same counts each time and the same receipt, still connected |

Notes for the real run:
- **Read the import's result from the database, not the log.** A Release build's JavaScript `console.log` doesn't
  reach the system log, so the `ardia-legacy imported` line never shows. `legacy.receipt` in `preferences` holds the
  same counts.
- **The data container moves on install.** It gets a new UUID path, with main's files inside, so look it up again with
  `get_app_container` after installing. Main's store lives in the app group container, not the app's own.
- **Main's search opens a new tab for each submitted address,** so each tab has a one-page back history. To check back
  history, follow links within one tab instead.
- **Not exercised on the stand-in:** Site Settings, blocking (a trusted site, a My Filters line, a list off) and the
  Reader's settings. The real run should set those too.
- **Private tabs aren't stored,** so they don't carry over, by design.
- **Tooling:** the run is the scripted pieces above plus agent-device steps. The real run is the same steps with
  `--seed <the owner's copy>`.

**The upgrade proof (2026-11-16, the owner's word: a made-up profile on this Mac counts).** Main's SwiftUI app (the ad
hoc build) was set up off its defaults in every place its source stores something (an Explore pass listed them: every
`UserDefaults.standard` key, the SwiftData store in the app group, Documents/Downloads, Caches, Application
Support/Sync, the Keychain, website data). It was connected to a scratch Mac seeded from a copy of the stand-in profile
with bookmarks added (`/tmp/ardia-phone-seed/standin-proof`). Then the Expo build at **d94eaf4c0** (JavaScript and
native from that commit, lab build) was installed over it, as an App Store update keeps the container. Evidence:
`/tmp/ardia-phone-shots/upgrade-proof/` (`before/`, `after/`, side-by-side `pairs/`). The import's receipt:
`{"tabs":8,"archive":1,"visits":11,"preferences":16}`.

The first full run (at f94bcc021) carried everything except History's hidden entries; d94eaf4c0 fixes that, and this
run is the proof. The same run's source pass found four other things the upgrade dropped, fixed before it in
434d07396: the deck's grid choice, hidden History, share-sheet sends and the widget's colour.

| Item | Before: main | After: the Expo build | Result |
| --- | --- | --- | --- |
| Open tabs | 8, in order (`ZBROWSERTAB`) | the same 8 URLs in the same order (`tabs`, diffed) | pass |
| Archive | 1 | 1 | pass |
| History | 11 visits | the same 11 URLs (`visits`, diffed) | pass |
| A History entry hidden in the Library | Page 1 hidden (`library.hiddenHistory`, seconds) | the same entry in `preferences`, in milliseconds | pass: stored, and missing from History after the upgrade while main's other visits show (run3) |
| Back history | main's saved state for each tab (`interactionState`) | the same bytes in `tab_state`; a tab restores what main saved | pass: main had saved the Wikipedia tab before its link was followed, so both apps restore one page; our own back history survives a relaunch |
| Page thumbnails | 9 in Caches/TabSnapshots | 9 `-legacy` pictures | pass |
| Website data | a page's cookie and localStorage `main1` | the page reads `cookie-main1` and `local-main1` | pass |
| Downloads | proof-note.txt in Documents/Downloads | the same file | pass: the file, and the Library's Downloads lists it (run3) |
| Bookmarks (from the Mac) | Ardia; Proof Folder with 2; Hacker News in Other Bookmarks | the same in the Library's Bookmarks (run3) | pass |
| Spaces, pins, the Mac's tabs | 4 spaces; Personal's 4 pins; the Mac's tabs | the same in the Spaces sheet and on the start page | pass |
| Sync With Mac | connected: Mac "shiv", "iPhone", folder Ardia Sync | the connected page, the same; no Connect step | pass |
| The Mac's view | one phone, kty6evegx…, 48 tab lines | the same one phone and id, 48 tab lines | pass |
| Site permissions | localhost: camera, microphone, location | the same grant (`browsing.sitePermissions`, identical) and Site Settings row | pass; Revoke Camera after the upgrade left Microphone and Location in the row and the stored grant, and the page asked for the camera again (run3) |
| Per-site settings | Wikipedia 125% and Night Shade on | identical `browsing.sites`; the page menu shows Night Shade on, 125% | pass |
| Block Ads, Trackers, Cookie Banners | on, on, off | the same | pass |
| Filter lists | Badware risks off; NoCoin added (303 rules) | the same selection and custom list | pass |
| My Filters | two lines, 2 rules | the same text, 2 rules | pass |
| Trusted Sites | example.com | example.com | pass |
| Night Shade, Swipe to Navigate, Collapse Bottom Bar | Automatic, From Screen Edges, on | the same | pass |
| Reader | size step 3, San Francisco, Sepia | the same; the Reader's menu shows San Francisco and Sepia at size 3 (run3) | pass |
| Appearance | Orange, Classic, Light | Orange, Classic, Light | pass |
| Search engine, suggestions | DuckDuckGo (set on the Mac), off | DuckDuckGo from the Mac, off | pass |
| Auto-Open Keyboard, Open App Links In | off, App | off, App | pass |
| Archive Inactive Tabs | After 7 days | After 7 days | pass |
| Deck as a grid | grid | grid | pass |
| Onboarding | finished | not shown again | pass |
| Relaunches | | about 15 during the checks, the same state each time; after two kill-and-relaunch cycles the receipt and the import marker are unchanged, nothing imported twice (run3) | pass |
| A tab sent each way | | the Mac's tab arrived once on the phone; a tab opened on the phone listed under it on the Mac (run3) | pass |
| Private tabs | 1 open before the screenshots | none | not carried, by design: main keeps them in memory only (`isPrivate` is transient) and drops them on its own relaunch, and the install ends main's process |

The four after-upgrade checks marked run3 ran on a second, shorter setup of main (the same scratch Mac, the grants, a
download, a hidden History entry and the Reader's values), upgraded to the Expo build at **dabc56f45**, on one lease
held for 30 minutes by an `agent-device` call every 20 seconds (`upgrade-proof/run3/`, its import receipt
`{"tabs":8,"archive":0,"visits":7,"preferences":6}`). The lease never dropped.
Not carried by design: Spotlight's fingerprints (rebuilt under a new key) and the bang list cache (the JavaScript
core has its own). Not applicable: the default-browser status (no entitlement in either build).

#### TestFlight: the workflow, its certificate and its testers

This was `docs/ios.md`'s, for main's SwiftUI app; since the clean-up the workflow builds only the Expo app.
- **The owner's rule** (2026-11-19). The owner asks for TestFlight before the dry run and upload.
  - **Version:** every TestFlight build is `1.0.1` (`CFBundleShortVersionString`) until the owner changes it. It is
    `TESTFLIGHT_VERSION` in `ios-release.yml`: `mode=dry-run` and `mode=upload` take it with `version` left empty, and
    stop at their first step on any other version, such as an old `0.2.47`.
  - **Build number:** App Store Connect picks it. Leave `build` empty and the run takes the one after the highest it
    holds.
  - **Steps:** a dry run at the commit to upload, `gh workflow run ios-release.yml -f mode=dry-run`, then the upload,
    `gh workflow run ios-release.yml -f mode=upload`, which reaches the Internal group only. In a desktop release,
    `iphone=true` on the Release workflow runs the same pair: its dry run signs, its real run uploads to Internal after
    the Mac release publishes. Public Testers stay a separate `mode=public-link -f build=<number>` run on the owner's
    word.
- **"Get a build on my phone"** means installing a development-signed build on the owner's iPhone. Use USB or pair
  the iPhone in Xcode's Devices and Simulators window for wireless debugging on the local network. Turn on Developer
  Mode and confirm the iPhone is available in `xcrun devicectl list devices`.
  - **Local Xcode.** When the Mac has development signing set up, build for the connected iPhone using
    `apps/phone/ios/Ardia.xcworkspace` and the `Ardia` scheme. Install the resulting development-signed `.app` with
    `xcrun devicectl device install app --device <udid> <path-to-Ardia.app>`. For a debugging session, select the
    iPhone as the run destination in Xcode.
  - **CI-signed IPA.** `gh workflow run ios-release.yml --ref <branch> -f mode=device -f udid=<udid>` registers the
    iPhone and builds the `ios-device-build` IPA from that ref. Its version defaults to the Mac app's
    `MARKETING_VERSION`. On the Mac connected to the iPhone, download and unpack the IPA, then install the app.

    ```sh
    gh run download <run-id> -n ios-device-build -D <scratch-dir>
    ditto -x -k <scratch-dir>/Ardia.ipa <scratch-dir>/unpacked
    xcrun devicectl device install app --device <udid> <scratch-dir>/unpacked/Payload/Ardia.app
    ```

  Confirm installation of `com.ardia.browser.ios` on the iPhone.
- **The app record.** "Ardia", bundle id `com.ardia.browser.ios`, team `U5L5T3NGVV`; the extensions are `.widgets`,
  `.share` and `.open`, sharing the app group `group.com.ardia.browser.ios`.
- **Talk to Me's voice** is not part of a build or an upload. Only a new voice needs a step, on a Mac:

  ```sh
  apps/phone/ios/TalkToMe/build-voice --out /private/tmp/ardia-talk-to-me-pack
  gh release create <tag> /private/tmp/ardia-talk-to-me-pack/phonon-31m-en.aar --repo ardia-browser/ardia-voices \
    --title <tag> --notes "<model and release it was built from>"
  ```

  Use a new tag (never replace a published asset, since older apps pin its hash), then update `url`, `bytes` and
  `sha256` in `VoiceDownload` (`packages/phone/ios/TalkToMe.swift`) with what `build-voice` printed. Phones that had
  the old voice download the new one the next time Talk to Me is on.
- **The workflow** (`.github/workflows/ios-release.yml`). What each mode touches in App Store Connect:
  - `mode=status` only reads: the app record, App IDs, devices, certificates, profiles, builds, build uploads and
    tester groups.
  - `mode=dry-run` reads the next build number, archives and signs with the stored development certificate
    (automatic signing, so Xcode may refresh its own managed profiles, as main's SwiftUI release always did), runs
    the checks and stops. It sends nothing. Until 2026-11-16 it also ran the app-store export, which opened an
    upload record and took the number though no build was sent: dry runs 43776739132 and 43868789082 left 0.2.47
    (10) and (11) as `AWAITING_UPLOAD`, and main's SwiftUI dry runs ran the same export.
  - `mode=upload` does the same, then exports for App Store Connect through the key the Mac release notarizes with
    (`NOTARY_KEY_P8`, `NOTARY_KEY_ID`, `NOTARY_ISSUER`), which opens the upload record and sends the build, and
    waits for processing.
  - The build number is one more than the highest App Store Connect has recorded, builds and upload records alike,
    unless `build` is set. With (10) and (11) held by empty records, the next upload then was 0.2.47 (12). An upload goes to the
  Internal group only. Use `public-link` for Public Testers after the upload processes. On a Mac, `apps/phone/scripts/release-ios` does the same with the account Xcode is
  signed in to, or with `ASC_KEY`, `ASC_KEY_ID` and `ASC_ISSUER`; `node apps/phone/scripts/asc.mjs --help` lists the
  App Store Connect client's commands.
- **CI's certificate.** The archive signs with one development certificate kept in `IOS_DEVELOPMENT_P12` and
  `IOS_DEVELOPMENT_P12_PASSWORD` ("Apple Development: Created via API", expires 12 Nov 2027), so a run makes and
  revokes nothing on the team; a revoked certificate mails the account holder. To renew it: make a key and a request
  (`openssl req -new -newkey rsa:2048 -nodes -keyout key.pem -out request.csr -subj "/CN=Ardia CI"`), run
  `mode=certificate` with `signing_request` set to the request's base64, download the `ios-development-certificate`
  artifact, pack it with the key into a .p12 with macOS's `/usr/bin/openssl`, and set both secrets. Distribution
  signing is Apple's cloud-managed certificate.
- **Public testers, once the owner says so.** `mode=public-link -f build=<number>` puts a build in the Public Testers
  group (kept off Apple silicon Macs, where the iPhone-only build crashes on open), sets its What to Test text from `apps/phone/ios/Config/TestFlight-WhatToTest.txt`, submits it for Beta App
  Review and prints the link, which stays the same for every build. Only one build of a version can wait in review.
  `mode=expire -f build=<number>` ends testing of an older build for good (never the newest), and `mode=add-tester -f
  email=<address>` invites someone to Public Testers.
- **The default browser grant.** iOS lists an app as a browser only when it is signed with
  `com.apple.developer.web-browser`, which Apple grants per App ID on request
  (https://developer.apple.com/contact/request/default-browser-entitlement/). It is granted and on by default
  ("Default browser on iPhone" above); `default_browser=false` (`--no-default-browser`) builds without it. iOS
  answers `UIApplication.isDefault(.webBrowser)` four times a year, so `DefaultBrowserStatus` keeps the last answer and asks only on returning from the Settings button or after 100
  days; a web link from another app also proves it.
- **Export compliance.** The only encryption is Apple's own (CryptoKit's AES-GCM, HKDF and HMAC for sync, and HTTPS),
  which Apple counts as exempt, so `ITSAppUsesNonExemptEncryption` is false and a build needs no compliance code.
  Adding a cryptography library, or an algorithm of our own, changes that answer.

#### Launch arguments on iPhone

Main's SwiftUI app reads these, and the Expo app is checked against them in test builds (step 11 of the tester
checklist). `-ArdiaDemo YES` runs on an in-memory store with the demo Macs and never touches real data; `-ArdiaSpace <name>`
starts in that space. Captures without touch: `-BrowseQuery <text>`, `-BrowseSurface browsing`, `-BrowseTab <n>`,
`-BrowseToolbar`, `-BrowseReader`, `-BrowseIncognito`, `-BrowseDelay <s>`, `-ArdiaDeck <script>`,
`-ArdiaOnboarding YES`, `-ArdiaOpenSheet archive|spaces|history|bookmarks|downloads`, `-BrowsePlus`,
`-BrowseOverlay <text>`, `-BrowseCollapsed`, `-BrowseOpen <url>`, `-ArdiaRestingStart`, `-ArdiaColor <name>`,
`-ArdiaInterfaceStyle glass|classic`, `-ArdiaColorScheme light|dark`, `-ArdiaSettingsPage <route>`,
`-ArdiaNoSitePermissions`, `-ArdiaDeckQuery <text>` and `-ArdiaDuoCanvas open|half`. Browse for Me's: `-BrowseResearch <query>`,
`-ArdiaResearchWriter excerpts`, `-ArdiaChatGPTIssuer <url>`,
`-ArdiaChatGPTAPI <url>` and `-ArdiaVoiceHeard <text>` ("Browse for Me (iPhone only)" above). Motion captures:
`-BrowsePagerFreeze <fraction>`, `-BrowsePagerScript` and `-BrowseLoadFreeze <progress>`. `-BrowseDeckPull <n>`
replays the swipe into the deck n times in a lab build ("The swipe into the deck" under Deck speed); it doesn't need
`-ArdiaDemo`.

#### Sync on iPhone

`ArdiaPhoneSync` on iPhone wraps the SwiftUI app's `SyncService` (ArdiaKit's ArdiaSync) whole, behind the same
interface and events as Android. `PhoneSyncHost` owns the one service: `AppDelegate` creates it in
`didFinishLaunching`, registers the background refresh task (`com.ardia.browser.ios.sync`) and starts it, so a
background launch with no scene runs a cycle without React Native. `SceneDelegate` tells it when the app becomes
active and resigns. Keys, the phrase's entropy and sealed bytes stay in Swift; only the typed phrase crosses, to
`connect`.

- **Continuing the SwiftUI app's sync.** Same bundle id, same container: the service reads `Application
  Support/Sync` (`sync.json`, `sync-state.nns`, `sync-journal.nns`, `sync-snapshot.nns`) and the `Ardia Sync Key`
  Keychain item, so a tester's phone keeps its device id and folder with no new connect.
- **The phone's data.** `packages/phone/ios/PhoneSync` (a Swift package the Podfile links into the pod) reads
  `Documents/SQLite/browser.db` read-only, one connection and one read transaction per cycle, with a busy timeout;
  the same rules as Android (open web tabs, 30 newest per profile, visits by page and profile, a missing file is an
  empty phone, a newer `user_version` fails the cycle). When the `-wal` and `-shm` files are gone it opens
  read-write with `query_only` on, since a read-only open can't start then. SyncService calls it on the main actor.
- **Sync's writes.** The inbox is `Application Support/PhoneSync/inbox.json` (excluded from backup), in Android's
  format and with its rules: replays add nothing, removals are merged and never dropped, an unreadable file is set
  aside, the next write refused and `inboxProblem` set.
- **Waiting for the import.** While the SwiftUI app's `Browser.store` exists and `legacy.markImported()` hasn't
  written `Application Support/PhoneSync/legacy-imported.json`, the source refuses to read and no cycle runs, in
  the foreground or in the background task; status says it is waiting. `legacy.imported()` reads the marker.
- **Widgets.** The host writes the Mac tabs widget's app-group snapshot with ArdiaDesign's `WidgetExporter`, the
  SwiftUI app's code, whenever the synced view changes.
- **Test build.** `ARDIA_TEST_BUILD=YES` on the xcodebuild line sets `ArdiaTestBuild` in Info.plist and
  `EXPO_PUBLIC_ARDIA_LAB=true` in the JS bundle phase; it is `NO` in the project, so a store build has no lab, no
  demo and no logging hooks. In a test build, `-ArdiaSyncDemo YES` swaps in `SyncService.demo` unless sync is set up,
  and `-ArdiaPageLab YES` opens the page lab. With Metro, start it with `EXPO_PUBLIC_ARDIA_LAB=true`.
- **Background refresh.** The app registers the task at launch and submits a request each time it resigns
  (the simulator's log shows `submitTaskRequest: <BGAppRefreshTaskRequest: com.ardia.browser.ios.sync …>`). On the
  iOS 27 simulator, `_simulateLaunchForTaskWithIdentifier:` from lldb on a backgrounded, suspended app did not run
  the handler. To check it on a device: run from Xcode, send the app to the background, pause, run
  `e -l objc -- (void)[[BGTaskScheduler sharedScheduler] _simulateLaunchForTaskWithIdentifier:@"com.ardia.browser.ios.sync"]`,
  continue, and look for the Mac's latest send in `Application Support/PhoneSync/inbox.json`.

**What ArdiaSync does** (it was `docs/ios.md`'s, and holds for the Expo app, which runs the same service). The iPhone
is a device in the Mac's chain: its own device id, its own logs, the same file format. A Mac that has never heard of
the iPhone reads its files.
- **Folder.** iCloud Drive › Ardia Sync, the Mac's default. iOS gives an app no path into iCloud Drive without a
  container entitlement, and the Mac writes there without one, so the iPhone asks for the folder once with the system
  folder picker and keeps a security-scoped bookmark. Picking iCloud Drive itself works too: the app looks for Ardia
  Sync (or Netnyahoo Sync) inside it. Reads and writes go through `NSFileCoordinator`, which makes iCloud bring files
  down; dataless files are reported as pending, as on the Mac.
- **Joining.** The Mac's Settings › Sync › Connect Another Device shows a QR code of the phrase. The iPhone scans it
  (or takes the 24 words typed or pasted), checks the checksum, and checks that the folder holds that phrase's chain
  before saving anything. Its errors are the Mac's. A different phrase entered after a failure clears the old error
  and, with a folder already chosen, tries again at once (`SyncConnectFlow`); the same words retyped don't.
- **Keys.** The phrase's entropy is kept in the Keychain (`Ardia Sync Key`, this device only,
  `AfterFirstUnlockThisDeviceOnly`, so background refresh can read it). The sync state (replica, base, version
  vectors, journal) is sealed with the file key in the app's container, like the Mac's `sync-state.nns`.
- **What the iPhone writes.** `dev:<id>` (its name), `tabs:<id>` (its 30 most recent open tabs), history visits as
  `h:<url>` (the Mac's union rule), `send:` records, and a new `bm:` bookmark in Other Bookmarks when you Pin to Mac
  (never from an Incognito tab, never an edit or delete of an existing bookmark). A page is pinned once: when the
  profile's bookmarks already hold its URL, Pin to Mac writes nothing, and `companionAddBookmark` refuses the
  duplicate too. It never writes settings, profiles, pins or passwords, keeps every record it doesn't use untouched in
  its replica, and doesn't compact; Macs do. `companion.test.ts` holds it to that against a fake Mac writing every
  kind of record today's Macs write and a kind no build knows yet.
- **What it reads.** Device names, profiles (`prof:`, `pth:`), the search engine settings (`set:searchEngine`,
  `set:customSearchUrl`, `set:customSearchEngines`), the look (`set:interfaceStyle`, `set:appearance`), and per
  profile the other devices' tabs, pinned tabs and groups, bookmarks and history.
- **Devices.** Settings › Sync lists the other devices by name, with no time: a device writes only when its own data
  changes, so the newest file from an idle Mac can be hours old. The list is ordered by each device's newest change.
- **Cycle.** On launch, on returning to the foreground, every 15 s in the foreground, 3 s after a local change, on
  pull to refresh, and in background app refresh.

**Code shared with the Mac.**
- Swift: `packages/sync/ios/Core` (recovery phrase, keys, file format, the vault) is the code the Mac runs, built for
  iOS through `packages/sync/Package.swift`; its macOS-only parts are behind `#if os(macOS)`.
- TypeScript: the merge (`packages/sync/src/scope.ts`, `hlc.ts`, `canon.ts`, `order.ts`) and the omnibox
  (`packages/core/src`) run in JavaScriptCore. `node apps/phone/scripts/bundle-shared.mjs` strips the types and writes
  `ardia-sync.js` and `ardia-core.js` into `packages/phone/ios/ArdiaKit/Sources/ArdiaShared/Scripts` from
  `packages/sync/src/companion/index.ts` and `packages/core/src/mobile.ts`. The bundles are checked in, Android
  compiles the same `ardia-sync.js`, and `--check` (run by the sync and core test scripts and `ios.yml`) fails when
  one is out of date. So a merge rule changed on the Mac is the phones' rule after the next bundle.

**Tests.**
- `swift test --package-path packages/phone/ios/ArdiaKit --scratch-path <scratch>`: sync end to end over a real vault
  with a fake Mac, the browser layer (tabs, archive, blocking, omnibox, reader extraction in a real WKWebView), the
  JavaScriptCore bridge and the design pieces. `SyncThroughICloudTests` carries files the way iCloud Drive does: late,
  out of order, as `.icloud` placeholders, with conflict copies; its soak runs hours of random edits on a test clock.
- `swift test --package-path packages/phone/ios/PhoneMotion` and `packages/phone/ios/PhoneSync`: the phone's own Swift.
- `ios.yml` runs all three, the sync core's Swift tests and the bundle check on pull requests and pushes to `main`
  that touch `packages/phone/ios`, `packages/sync`, `packages/core` or the bundler.
- Left for a person: a real iPhone and a real Mac on one iCloud account (scan, pick the folder, watch tabs, history,
  bookmarks and sends go both ways, a reboot keeps the folder). The simulator can't sign in to iCloud Drive.

A `WKWebView` is made only once the app has a window (`WebEngine.canMakeWebViews`). UIKit gives a gesture recognizer
its delayed-touch dispatcher when it is created, so a web view built before the scene's window aborts on its first
scroll touch (`-[UIGestureRecognizer _delayTouchesForEvent:inPhase:]` inserting nil).

Edge swipes for back and forward are WebKit's own gesture. Simulator automation (agent-device swipes and pans from
the edge) has never triggered it; check it with a finger on a device or with the mouse in the Simulator window.

The first build takes about 25 minutes on a busy Mac; a native-only change rebuilds in 3 to 5, since the codegen and
Expo provider phases publish only files that changed.

