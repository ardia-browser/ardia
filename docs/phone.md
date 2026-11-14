# Ardia for phones (Expo)

One Expo app for both phones, replacing `apps/ios` (SwiftUI) and `apps/android` (Compose) step by step (issue #1556).
Screens, app state and the data store are TypeScript; what has to be native is an Expo module wrapping the Kotlin and
Swift code that already exists. Both phones run it: Android and the iPhone.

## Layout

```
apps/phone/                 the app: Expo 54, React Native 0.81.6 (the Mac's versions), new architecture, Hermes
  android/                  the Android project, checked in (application id com.ardia.browser.android, minSdk 29,
                            arm64-v8a and x86_64)
  src/                      the Mac's folder rules (docs/conventions.md): components/ui, components/<feature>,
                            state/<domain>, platform, lib
  ios/                      the iPhone project, checked in (bundle id com.ardia.browser.ios, the SwiftUI app's, iOS 27,
                            iPhone only, React Native's prebuilt core)
  scripts/gradle-locked     Gradle under the same lock as apps/android, so one Android build runs at a time
packages/phone/             @ardia/phone-native, the Expo module package
  src/                      the TypeScript side: PageView and its types
  android/                  the Kotlin side. Its Gradle build compiles apps/android/browser's sources, assets and
                            resources directly (namespace com.ardia.browser), so both apps run one PageEngine
  ios/                      the Swift side, pod ArdiaPhoneNative. It builds against ArdiaKit's ArdiaBrowser, so the
                            SwiftUI app and this app run one WebEngine and WebTab
```

`@ardia/core` is imported straight from `src/mobile.ts`; no bundle, no script engine.

## The page view

`PageView` (`packages/phone/src`) is the page. Android backs it with `PageEngine` from `apps/android/browser`
(`DevelopmentWebViewEngine` over the system WebView today). The iPhone backs it with `WebEngine` and `WebTab` from
`apps/ios/Packages/ArdiaKit` (WKWebView with the SwiftUI app's content blocking, popups, downloads and page requests),
in an in-memory tab store until this app takes over the SwiftUI app's data. Its tone is `PageTone.resolve` and
`ToneSampler` in ArdiaBrowser, the code the SwiftUI app's bar uses. The page takes iOS's edge swipes for back and
forward.

- Props: `pageId` (a page lives in the native engine under this id and survives remounts), `initialUrl` (loaded when
  the page is first opened), `toneInsets` (dp at the top and bottom to leave out when sampling the page's tone).
- Events: `onPageState` (`url`, `title`, `progress`, `isLoading`, `canGoBack`, `canGoForward`) and `onPageTone`
  (`top`, `bottom` as `#RRGGBB`, already resolved from theme colour, background colour and the sampled bands). Native
  sends both on one `onPageEvent` channel; the wrapper splits them.
- Handle: `loadUrl`, `goBack`, `goForward`, `reload`, `stopLoading`. `closePage(pageId)` ends a page.

`browser`'s `Omnibox.kt` (the ScriptEngine bridge) and `PageSurface.kt` (Compose) are left out of the module's build:
the Expo app calls `@ardia/core` itself and hosts the page's view natively.

## Sync on Android

Sync is a native subsystem with its own script runtime; the app's JavaScript never sees the host functions,
keys, the phrase's entropy or sealed bytes. `@ardia/phone-native` compiles `apps/android/sync` and
`apps/android/shared` in place, and `ArdiaPhoneSync` (`packages/phone/src/sync.ts`) wraps `SyncController` whole:
status and the synced view as getters and events, connect and change folder with the system folder picker, sync
now, stop, the reset notice, device name, profile, send, pin to Mac, incoming sends. One controller owns every
cycle on its own thread; `MainApplication` is the `SyncControllerOwner`, so WorkManager's `SyncWorker` (every 15
minutes, and a flush after the app leaves the screen) runs it without React Native.

- **Runtime.** `ardia_hermes.cpp` builds against React Native 0.81's prefab Hermes, JSI and fbjni
  (`ARDIA_REACT_NATIVE_HERMES` picks the runtime options that Hermes has), so the process has one Hermes and sync
  gets its own runtime instance. `libardiahermes.so` needs only the `libhermes.so`, `libjsi.so` and
  `libfbjni.so` the app ships.
- **Bytecode.** React Native 0.81's `hermesc` rejects `async` functions and classes in `ardia-sync.js`, and
  its hidden `-block-scoping` flag crashes on it; there is no `-Xes6-block-scoping` in that compiler. So
  `CompileSyncBundle` (`packages/phone/android/build.gradle`) runs the bundle through Babel's class, block-scoping
  and async-to-generator transforms, the ones React Native applies to app code for this Hermes, then compiles it
  with React Native 0.81's `hermesc`, pinned by sha256. The Compose app compiles the same source with
  `hermes-compiler` 0.88.1 and `-Xes6-block-scoping`. The step proves the two cannot differ: Babel must leave
  no `let`, `const`, class, `async` or `await` (each loop variable a closure captures becomes its own `_loop`
  function, so a binding per pass does not depend on the engine); closures in loops, through the same
  transform, must keep each pass's value; the whole companion suite (`packages/sync/src/companion`) runs
  against the transpiled bundle; and the transpiled bundle must make the same host calls as the original.
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
   `adb shell am kill com.ardia.browser.android`, then
   `adb shell cmd jobscheduler run -f com.ardia.browser.android <job id>` (ids from
   `adb shell dumpsys jobscheduler com.ardia.browser.android`). Open the app: the change is there before the
   first foreground cycle, and the inbox holds any tabs the Mac sent.
7. **Stalled age.** Turn on airplane mode and wait three minutes: the status reads `Last synced N minutes ago`
   and N moves each minute.
- **Scanning the phrase.** The module's own `ScanView` (`scanner`, `@ardia/phone-native`) scans the Mac's QR code
  with the Compose app's CameraX and ZXing code and hands the text to `sync.connect`; expo-camera and its ML Kit are
  gone (00b9064e9). It asks for the camera again once a one-time grant has expired (d8460729e).

## System entry points on Android

The Expo app has the Compose app's entry points (`docs/android.md`), from its own code where it can be shared.
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
- **Tile, widgets and shortcuts.** The Compose app's `SearchTileService`, Glance widgets (Search, Your Mac's Tabs)
  and `SystemSnapshots` compile in place in the Expo app, with its `res-system` resources and a small
  `ardia-design` library for `ProfileLook`, `Monogram` and `Colors`. `SystemExport` writes the widgets'
  snapshot from the wrapped sync controller, as the Compose app does; demo mode feeds no widgets.
- **Not ported.** The share sheet's Send to Your Mac (sharing opens the page in Ardia instead), and the Color
  setting's tint of the widgets.
- **Files.** A file request carries `offersPhoto`, `offersVideo` and `capturesDirectly` (the Compose app's
  `FileChooserPlan`); the answers `takePhoto` and `recordVideo` capture through the shared capture provider.
- **Open App Links In.** A global default (`pages.appLinksDefault`, `setAppLinksDefault`) with each site on,
  off or following it (`setOpensLinksInApps(host, null)`).

#### Entry points tester script (lab build)

`P=com.ardia.browser.android/.MainActivity`. Open the lab
(`adb shell am start -n $P --ez com.ardia.phone.PAGE_LAB true`), tap System, and watch
`adb logcat -s ReactNativeJS:I | grep "PAGELAB system"`. Each command should print one `PAGELAB system link`
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
15. **Sync, demo mode:** Stop Syncing turns the demo off (the card and the deck show the disconnected state);
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
22. **Online again and favicons:** System › Favicon looks prints three lines with tones and backings; turn
    airplane mode on and off: `network lost`, then `online again` once.
23. **Accessibility dump:** in the app (not the lab), open the tray, the page menu, a long-press menu, Spaces
    and the Archive sheet in turn, and with each open run
    `adb shell am broadcast -a com.ardia.phone.A11Y_DUMP -p com.ardia.browser.android` and
    `adb logcat -d -s PAGELAB | grep "PAGELAB a11y"`. The lines between `begin` and `end` are what TalkBack can
    reach; the surface behind a cover should not be among them.

## Telemetry

Off until the user chooses, in Settings (Share anonymous usage stats, with What's Sent) or on onboarding's last step. The consent model is the Mac's: nothing is sent, queued or counted while sharing is off, turning it off drops the queue, the day's counts and any request in flight at once, and an install ID is made only the first time sharing is turned on. Unlike the Mac, the phone sends no `daily_active` ping while sharing is off.

The gate is one file, `apps/phone/src/lib/telemetryGate.ts` (`createGate`): every capture, count and send goes through `isSharing()` there, and `state/telemetry/telemetry.ts` makes the app's one instance on the preferences table (`telemetry.sharing`, `telemetry.installId`, `telemetry.daily`, none of which the old iPhone app's import can set). The schema is `lib/telemetrySchema.ts`: every field is a fixed value, an enum, a bounded count or duration, or a version or UUID pattern, and a record that fails it is never queued. The OTLP encoding is shared with the Mac through `packages/core/src/telemetryWire.ts`.

Events (service `ardia-phone`, `$lib` `ardia-phone-telemetry`, tags `app: phone` and `platform: android|ios` on every one):

| Event | Fields | When |
| --- | --- | --- |
| `sharing_turned_on` | `source` (settings, onboarding) | turning sharing on |
| `app_launched` | `legacy_import` (imported, skipped, none) | each launch with sharing on |
| `perf_launch` | `launch_ms`, `js_ms` | each launch, once the module gives the process start (`ArdiaPhoneSystem.processStartedAt()`, epoch ms) |
| `usage_counts` | `tabs_opened`, `searches`, `pins_to_mac`, `tabs_sent`, `page_processes_gone` | at most once a day, for the last UTC day the app was used before today, when anything was counted; private tabs are never counted |

On the dashboard they are kept out of every Mac section by source and lib (`PHONE_APP_SOURCE` in `apps/dashboard/src/server/sql.ts`).

## What is left before the Expo app replaces both native apps

The bar is the Compose app on Android and the SwiftUI app on iPhone, screen by screen and setting by setting:
what each tap does, what is remembered, animations and their timing. Every item is one line: what it is, where it
lives in the native app, and its size (small: an hour or two; a day; more). Anything not yet seen working on a
phone is listed as unverified, even where the code is in. Audited 2026-11-14 at 608a701c5.

### Needs only JavaScript

- Search tray: search links (`ardia://search?q=`, web search, process text, shared text, Siri) open the tray with the words instead of searching at once as both apps do. `AppModel.kt` `handle()`, `AppModel+System.swift` `handle(_:)`. Small.
- Search tray: a voice link shows the voice screen alone; both apps put the tray under it so Cancel lands on the tray. Same files. Small.
- Search tray: the mic button leaves the field focused; both apps drop focus while voice is up and give it back. `SearchTray.kt`, `SearchTray.swift` (`mayFocus`). Small.
- Search tray: the calculator row does nothing; both apps copy the value with a "Copied …" toast, offer Copy on long-press and title it "= value". `AppModel.kt`/`SearchTray.kt`, `AppModel+Search.swift`/`SearchTray.swift`. Small.
- Search tray: bang queries lack their "Search <engine>" detail line. `SearchSuggestions.kt` `row()`, `SearchSuggestionsModel.swift` `row(for:)`. Small.
- Search tray: 8 rows and no kept row for the exact typed query; both apps show 9 and keep it. Same files. Small.
- Search tray: Mac-tab rows show the device name as text; both apps show a laptop icon and the host, and Switch to Tab uses `arrow.right.circle`. `SuggestionList.kt` `RowLabel`, `SuggestionRowView.swift`. Small.
- Search tray: no scrubbing along the rows (highlight under the finger past 6 pt, a tick per row, open on release, press spring 0.2/0.7). `SuggestionList.kt`, `Scrub.kt`, `SearchTray.swift` `scrub`. A day.
- Search tray: no drag down to close from the header, caption or empty area (the dim follows, traySettle 0.34/0.86 or dismiss past a threshold). `SearchTrayHost.kt`, `TrayDrag.kt`, `SearchTrayHost.swift`, `TrayDrag.swift`. A day.
- Search tray: closing is not animated (trayDismiss 0.32/1, dim fades 300 ms, waits for the keyboard); the dim pops in. Same host files. A day.
- Search tray: the rise does not follow the keyboard (IME insets on Android, the keyboard's own curve on iPhone, landing after 450 ms); Reanimated's `useAnimatedKeyboard` can drive it. `TrayPresentation.kt`, `TrayLift.kt`, `SearchTrayHost.swift`, `KeyboardTracker.swift`. A day.
- Search tray: Reduce Motion ignored (both apps use a 200 ms fade or settle). `SearchTrayHost.kt`, `SearchTrayHost.swift`. Small.
- Search tray: no 140 ms crossfade between caption, rows and empty (`resultsIn`). `SearchTray.kt` `TrayBody`, `SearchTray.swift`. Small.
- Search tray: no fade mask at the bottom of overflowing rows (the list now ends at the last whole row). `SearchTray.kt` `FADE_MASK`, `SearchTray.swift` `fadeMask`. Small.
- Search tray: the incognito toggle's label pops instead of fading and scaling from 0.9 (modeToggle 0.3 s, bounce 0.15). `IncognitoToggle.kt`, `IncognitoToggle.swift`. Small.
- Search tray: field text is body, not title3 that scales with text size; the incognito caption is not centred semibold; past 1.5× text size rows don't wrap to 3–4 lines and scrubbing doesn't turn off. `SearchTray.kt`, `SearchTray.swift`, `SuggestionRowView.swift`. Small.
- Search tray: rows expose one "More Actions" (menu at y 0); Compose exposes Refine and each menu item as accessibility actions. `SuggestionList.kt`. Small.
- Start page: with no tabs and sync on, the leading button should be Synced Tabs (opens Spaces); the logo should fade and scale from 0.92 and the bar fade with searchRise instead of snapping. `SearchHomeView.kt`, `SearchHomeView.swift`. Small.
- Voice screen: no 150 ms transcript crossfade, no logo shadow (12 dp, 15%), no 100 ms waveform ease (iPhone). `VoiceSearchView.kt`, `VoiceSearchView.swift`. Small.
- System links: a tab link opens archived and private tabs as they are; both apps refuse private ones and restore archived ones, and Compose waits for the store before giving up on an unknown id. `AppModel.kt` `openTabFromSystem`, `AppModel+System.swift`. Small.
- System links (iPhone): pages from the share sheet open with origin `link`, not `share`. `AppModel+System.swift` `drainSystemInbox`. Small.
- Deck: no selection tick as the focused card changes, no light impact on a flick-close, no medium impact on confirming Close All or Close Incognito Tabs. `DeckState.kt`, `TabSwitcherView.kt`, `TabSwitcherView.swift`. Small.
- Deck: Android haptics use expo-haptics' vibrator calls; Compose uses the view's system haptics (tick, key, long press, confirm, reject), which follow the touch-feedback setting. expo-haptics 15 has `performAndroidHapticsAsync`. `Haptics.kt`. Small.
- Deck: no poof (9 puffs over 420 ms) where a card closes. `PoofBurst.kt`, `PoofBurst.swift`. A few hours.
- Deck: opening without a page shows the cards at once; both apps fade them in over 200 ms, and crossfade a handoff cover when the page could not be animated. `DeckState.appear`, `TabSwitcherView.swift` `appear()`/`DeckCover`. Small.
- Deck: the backdrop, bar and chip pop in and out around open and close; both apps fade the backdrop with position×1.4 and the chrome over the last 40%, and hide the chip while a card is lifted. `DeckPose.kt`, `TabSwitcherView.kt`, `TabSwitcherView.swift`. Small.
- Deck: Reduce Motion ignored (both apps crossfade to open, close without the fly-away, and settle and close gaps with a 200 ms fade). `DeckState.kt`, `TabSwitcherView.swift` `crossfadeOpen`. Half a day.
- Deck: the page mounts only when the open spring ends; both apps select the tab and make its view when the spring starts, so the page is ready under the card. `DeckState.open`, `AppModel+Tabs.swift` `prepareToOpen`/`beginOpening`. Half a day.
- Deck: system Back leaves without the expand animation and ignores the focused card; Compose closes the card menu, then the archive card, then opens the selected or focused tab with the animation. `DeckState.back()`. Small.
- Deck: the card menu lacks Send to <device> and Pin to Mac. `TabCard.kt` `CardMenu`, `TabSwitcherView.swift` `CardMenu`. Small.
- Deck: no "From Your Mac" badge on received tabs not yet seen. `TabCard.kt` `ReceivedBadge`, `TabCardView.swift`. Small.
- Deck: card headers lack the trailing fade, the icon reveal, the leading placement and the 1.35 text-size cap. `TabCard.kt` `DeckCardHeaderItem`, `DeckHeaderLayout.swift`. Half a day.
- Deck: snapshots don't fade in over 200 ms; the placeholder colour hashes the whole URL, not the host; its title is body semibold, not headline. `TabCard.kt`, `TabCardView.swift`. Small.
- Deck: card shadow is elevation 6; both apps use radius 18, offset (−2, 4) on iPhone and elevation 14 on Android. `TabDeckPlacement.swift`, `DeckModifiers.kt`. Small.
- Deck: every card is mounted; both apps draw only the cards within 6 of the scroll position. `TabsDeckGeometry.swift`, `DeckState.renderedRange`. Small.
- Deck: no page-left/page-right accessibility scroll actions, and the Close Tab action animates. `TabSwitcherView.kt`, `TabSwitcherView.swift`. Small.
- Deck: a tap on a card that is lifted or flying away still opens it. `DeckState.open`. Small.
- Archive card: enters with a fade only; both apps fade and scale from 0.96. `TabSwitcherView.kt`, `TabSwitcherView.swift`. Small.
- Auto-archive: runs at launch, on becoming active and on an interval change; both apps also run it every 15 minutes while active and prune expired archive rows on becoming active, and the iPhone holds it while the deck is dragged. `TabStore.kt`, `TabStore.swift`. Small.
- Archive: day titles always "weekday, month day"; both apps say Today, Yesterday, the weekday within six days, then the date (with the year if it differs). `ArchiveView.kt` `ArchiveDayLabel`, `ArchiveView.swift`. Small.
- Archive: no tick on restoring a row, no warning haptic on Delete All, and Delete All is enabled when empty. `ArchiveView.kt`, `ArchiveView.swift`. Small.
- Archive: empty and no-results states are text only; both apps show the 64 pt archive tile or a magnifier, and the empty state even while a query is typed. `ArchiveView.kt`, `ArchiveView.swift`. Small.
- Archive: rows put a tile behind the favicon and day headers have no background (sticky only on iPhone, where text overlaps); both apps draw a plain favicon at 20× text size on sticky headers with a 0.92 surface tint. `ArchiveView.kt`. Small.
- Archive: Back closes the sheet with a query typed (Compose clears the query first), and search runs on every keystroke (Compose waits 120 ms). `ArchiveView.kt`. Small.
- Archive (iPhone): a full swipe deletes a row; SwiftUI only reveals Delete (`allowsFullSwipe: false`). `ArchiveView.swift`. Small.
- Page: no haptic on pressing a bottom-bar control (Compose VIRTUAL_KEY, SwiftUI light impact 0.5). `BottomBar.kt` `barPress`, `BottomBar.swift`. Small.
- Page: no tick when a tab swipe lands on the next tab. `BrowsingView.kt` `TabPager`, `BrowsingView.swift` `tabSwitchTicks`. Small.
- Page menu: no success haptic when Pin to Mac fills the star (iPhone). `ToolbarSheet.swift`. Small.
- Page menu: "Copied URL" in the title stays 1.5 s and swaps; SwiftUI shows it 1 s and crossfades. `BrowseSession.swift`, `ToolbarSheet.swift`. Small.
- Page menu: at accessibility text sizes the title stays one line; SwiftUI moves it under the buttons with up to 3 lines. `ToolbarSheet.swift` `navigationCapsule`. Small.
- Page menu: Find on Page opens at once; SwiftUI closes the menu and shows the find bar 350 ms later. `ToolbarSheet.swift` `findRow`. Small.
- Page menu: Site Settings closes the menu and jumps to Settings; Compose opens it inside the menu sheet with a back button, and Back returns to the menu (SwiftUI has no such row). `PageMenu.kt`, `BrowsingView.kt`. Small.
- Downloads: progress and cancel are not shown anywhere in the app (only the lab uses `downloads.progress`/`cancel`). `SystemDownloads.kt`, `DownloadManager.swift`. Small to a day.
- Long-press Copy Link says "Copied URL"; Compose says "Copied URL Without Trackers" (the app's own `COPIED_LINK`). `AppModel.kt` `copyLink`. Small.
- Find: the bar swaps in for the bottom bar at once; Compose hides the bottom bar with its collapse animation. `BrowsingView.kt` (`barHidden || isFinding`). Small.
- Reader: text can't be selected (Compose `SelectionContainer`), size changes jump (Compose animates them), and the lead image loads any address (Compose only http and https). `ReaderView.kt`. Small.
- Haptics in Settings, sync and onboarding: none on clearing data, filter-list update/add/apply, Sync Now done or failed, Stop Syncing, a scanned or valid phrase, connected or failed, each onboarding step and the finish; needs a warning/error helper beside `tapHaptic`. `GeneralPages.kt`, `SyncPages.kt`, `BlockingPages.kt`, `OnboardingView.kt`, `SyncCodeScanner.kt`; `ClearBrowsingDataPage.swift`, `FilterListsPage.swift`, `SyncSettingsPage.swift`, `SyncConnectPage.swift`, `RecoveryPhraseEntryPage.swift`, `OnboardingView.swift`. Under 2 hours.
- Toasts: enter with a fade only and leave with none; both apps slide in 24 dp from 0.92 scale on a snappy spring and slide out 16 dp, a plain fade with Reduce Motion. `Toasts.kt`, `ToastView.swift`. Small.
- Toasts: no drag (a finger holds the toast, a fling down past 40 or a drag past 24 dismisses it, else it springs back and the timer resumes 1.2 s). `Toasts.kt`, `ToastView.swift`. Small.
- Toasts: the same message shown again replays the entrance; both apps only extend its time. `Toasts.kt`, `ToastCenter.swift`. Small.
- Toasts: with the keyboard up the toast sits above the keyboard; both apps move it to the top of the screen. `Toasts.kt`, `ToastView.swift`. Small.
- Toasts (iPhone): VoiceOver doesn't announce them (`accessibilityLiveRegion` is Android only); needs `announceForAccessibility`. `ToastCenter.swift`. Small.
- Onboarding: steps slide a full screen width in with no exit and no Reduce Motion check; both apps slide 60 dp with a fade in and out, a fade only with Reduce Motion, and hide the keyboard on each step change. `OnboardingView.kt`, `OnboardingView.swift`. Small.
- Sync page: no pull to run a sync cycle (Compose). `SyncPages.kt`. Small.
- Sync connect: Compose starts connecting by itself once the phrase is valid and a folder is ready; the app waits for the tap. `SyncPages.kt`. Small.
- Settings root: at accessibility text sizes the sync card stacks its tile above the text (44 dp tile) and the Archive and Spaces buttons stack; the card's status line crossfades when it changes. `SettingsRootPage.kt`, `SettingsView.swift`. Small.
- Profile colour: the swatch ring doesn't animate to the picked colour. `ColorChoice.kt`. Small.
- Spaces: no swipe between profiles (the switcher slides since 616d4a43f), and no tick on switching (iPhone). `SyncedSpacesView.kt`, `SyncedSpacesView.swift`. A day.

### Needs native code on Android

- Search field: no inline completion (the suggested address's rest highlighted after the caret, so Enter on "goo" opens google.com); React Native's field can't overlay a suffix or see the IME's composing text, so it needs a native field. `CompletingFieldState.kt`, `OmniboxTextField.kt`. More.
- Search tray: no predictive back (the tray follows the back gesture down 72 dp); React Native's back handler gives no progress. `SearchTrayHost.kt` `PredictiveBackHandler`. A day.
- Share sheet: no Send to Your Mac (Compose's ShareActivity offers Open, Search and Send). `share/ShareActivity.kt`, `ShareSheetModel.kt`, `ShareSheetView.kt`. A day.
- Widgets: the Color setting doesn't tint them. `system/WidgetColors.kt`, `SystemSnapshotExport.kt`. Small.
- Page permission order: Compose asks Android for camera, mic or location first and shows the site's Allow dialog only once Android grants it (a refusal ends quietly); the app shows the site dialog first. Needs a check-or-request call before the dialog. `PageRequests.kt` `PermissionRequest`. Small.

### Needs native code on iPhone

- Voice search: no speech module, so the mic is hidden and voice links, the intent and the control fall back to the tray. `VoiceDictation.swift`. A day.
- Search field: no inline completion; needs a native field. `OmniboxTextField.swift` (`CompletingTextField`). More.
- Spotlight: open and archived tabs aren't indexed. `SpotlightIndexer.swift`. A day.
- Shortcuts and Siri: no Open Tab intent or tab entity in the app target (`apps/phone/ios/Ardia/Intents.swift`). `ArdiaIntents.swift` `OpenTabIntent`, `TabEntity.swift`. A day.
- Handoff: the current page isn't offered to other devices (incoming works). `SystemIntegrations.swift`, `AppModel+System.swift`. Small.
- Deck bar: SwiftUI's buttons are interactive Liquid Glass (`.glassEffect(.regular.interactive())`); the look module's Frost needs a glass variant that samples the deck. `TabDeckBar.swift`. A day.
- Context menus: SwiftUI uses system context menus (lift preview and blur) on cards, the plus button and archive rows, with ShareLink; the app draws its own. Needs a native context-menu view. `TabSwitcherView.swift`, `TabDeckBar.swift`, `ArchiveView.swift`. A day.
- Swipe to Navigate: the page view has no `swipeNavigation`, so the setting does nothing and only WebKit's edge swipe runs; SwiftUI swipes from anywhere with snapshot parallax, a shade and a haptic at the commit point. `WebPageView.swift` `swipePan`/`handleSwipe`. A day.
- Pull to refresh: no `pullToRefresh` on the page view; SwiftUI uses a refresh control tinted with the loading colour. `WebPageView.swift`. Small.
- Open in Background opens in front: the module drops `inBackground` from the link callback, and the app selects every popup. `WebTab.swift`, `PhonePages.linkOpened`. Small (plus a JS line).
- Offline pages never retry by themselves: failures carry no reason and there is no network module, so no online-again signal and no Wi-Fi-off icon. `WebTab.swift` `PageLoadFailure.network`. Small, plus an hour or two for an `NWPathMonitor` module.
- Per-site Open App Links In: `siteOpensLinksInApps`, `appLinksDefault` and `setAppLinksDefault` are missing, and clearing a site's choice (null) can't decode. `BrowsingPreferences.swift`. Small.
- Long-press on links and images uses WebKit's context menu (as SwiftUI does), so the app's drawn menu, Save Image and the Copied URL toast are Android-only; matching Android needs native long-press events. `WebTab.swift`. A day.
- Clear Browsing Data: cache and cookies are cleared for all time whatever range is picked; SwiftUI passes the range's start. Needs `since` on `clearWebsiteData`. `ClearBrowsingDataPage.swift`, `BrowsingPreferences.swift`. Small.

### Unverified on a phone

- iPhone look views: `packages/phone/ios/LookModule.swift` is in progress (uncommitted); until it lands the iPhone draws gradients and solid fills. Check: the deck's animated backdrop and frosted controls, and Reduce Motion and Reduce Transparency switching them.
- Scroll position restore: scroll a long page, kill the app, relaunch; the same tab opens at the same offset, also after it was discarded in the background (both phones).
- Card snapshot on deck entry: open the deck right after scrolling; the card shows the current view.
- Deck gestures: a 400 ms hold opens the card menu without scrolling, a slow vertical drag lifts, a tap right after a settle opens the right card.
- Incognito chip: compare its tap with Compose's `IncognitoChip` (SwiftUI shows a one-item menu, as the app does).
- Voice from the tray: the keyboard goes down over the voice screen and comes back on the tray after Cancel.
- Refine arrow with TalkBack and VoiceOver: reachable, read as "Refine <title>".
- iPhone Lock Screen widgets and Control Center controls open the right link (the app target has its own intent copies).
- iPhone search widget follows the profile colour and Match My Mac (`WidgetExporter.swift`).
- Android Paste and Go: "Link You Copied" for a link, "Text You Copied" for text (c872c609f).
- iPhone page permission prompts (camera, mic, location): Allow and Don't Allow from the app's dialog reach WebKit's grant.
- iPhone file upload: WebKit's own picker appears for a file input and Take Photo works (the module answers no file requests itself).
- iPhone fullscreen video covers the bottom bar and hides the status bar and home indicator.
- iPhone Share from the long-press menu is not shown under an open sheet.
- Android notification permission requests and the download notification compared with Compose's `PageRequests.kt`.
- Bar collapse spring and travel against Compose's `Motion.barCollapse` and SwiftUI's `BottomBar.swift`.
- Status-bar icons stay readable over the page menu, Reader and the long-press shade on both phones.
- iPhone Desktop Site reloads the page as SwiftUI's `toggleDesktopSite` does.
- The page's bar colour follows a page whose colour changes on scroll (Compose samples again 250 ms after a load and on scroll direction or top-of-page changes, `BrowsingView.kt`).
- A site's notification permission request, compared with Compose.
- iPhone: a toast raised from Settings (Cleared Browsing Data) shows above the sheet, as SwiftUI's own toast window does.
- A tab sent from the Mac shows a toast on both phones and tapping it opens the tab (SwiftUI `ReceivedTabsAnnouncer.swift`).
- Turning Match My Mac off with a Mac custom theme keeps the colour Compose's `choiceAfterMatchToggle` keeps.

### Deliberately different

- Voice screen status-bar icons: always light; Compose takes them from the light-mode tint although the screen is always dark (3a9ca2f10, `lib/statusInk.ts`).
- Pin to Mac from the page menu: Android keeps Compose's toast, iPhone answers in the menu's title as SwiftUI does (5023ecabd).
- Paste and Go: Android only; SwiftUI has no such row (`lib/platformCopy.ts` `offersPasteAndGo`).
- Wording: each phone keeps its native app's words through one copy table per platform (`lib/platformCopy.ts`, 5db9a2263).
- Settings, the Archive and Spaces share one drawn sheet on both phones, as Compose's `SheetHost` (3a9ca2f10); SwiftUI uses the system sheet.
- Menus are drawn by the app (`components/ui/Menu.tsx`) on both phones, not system menus, so they match across platforms.
- Backdrops: native look views where the module has them, CSS gradients elsewhere; no Skia (the owner's decision).
- The code scanner is the module's own view (`ScanView`); expo-camera and its ML Kit are gone (00b9064e9).
- Tray rows end at the last whole row and scroll, so the iPhone's taller keyboard never cuts a row (992441306).
- A suggestion whose text is an address opens that address, so a row tap does what Enter does (87bc6e89f).
- A link that arrives during onboarding is held and only the last one runs afterwards (43753d1b5); both apps act at once.
- The deck bar sits 6 points above a three-button navigation bar instead of on it (2db78f033); gesture navigation keeps Compose's numbers.
- Find on Page is the app's own bar on both phones, not WebKit's find panel as in SwiftUI (e508b6dd2); the commit gives no reason, so the owner should confirm it.
- Opt-in usage stats (Settings, What's Sent, onboarding's last step) exist only in the Expo app (c6ebf08a8, the owner's approval).
- Settings has no Appearance or Downloads rows because Compose has neither (f5d1ec9f2).
- Toasts sit above the deck bar's measured top, not a fixed 64 dp, so they never cover + (87e9ed9e6).

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
`apps/ios/Packages/ArdiaKit` to the `ArdiaPhoneNative` pod as a local Swift package (ArdiaBrowser and ArdiaDesign);
Xcode links ArdiaKit into the pod's library and copies its resource bundles into the app. The app target must not
link ArdiaKit itself, or every symbol is linked twice; it finds ArdiaDesign's module for its intents through
`SWIFT_INCLUDE_PATHS`. iOS 27 refuses to launch an app without the scene lifecycle, which Expo 54's template lacks, so
`SceneDelegate` starts React Native in the scene's window and hands links, quick actions and Handoff to the module.

The project carries the SwiftUI app's extensions, compiled from `apps/ios/Share`, `Action` and `Widgets` in place with
that project's Info.plists and entitlement files: the Share extension, Open in Ardia and the widgets, under the same
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

Edge swipes for back and forward are WebKit's own gesture. Simulator automation (agent-device swipes and pans from
the edge) has never triggered it; check it with a finger on a device or with the mouse in the Simulator window.

The first build takes about 25 minutes on a busy Mac; a native-only change rebuilds in 3 to 5, since the codegen and
Expo provider phases publish only files that changed.
