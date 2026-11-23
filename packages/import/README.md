# @ardia/import

Imports another browser's data into Ardia. The native code lives in `ios/`; `ios/Core/` is plain Swift with no
Expo dependency, so `Package.swift` builds and tests it on its own. `src/index.ts` is the typed JS wrapper and the UI
is `apps/browser/src/components/import/`. Every test reads fixtures. Never point anything at a real profile. On Windows the
same module is TypeScript in `packages/expo-windows/src/import` (`docs/windows.md`, Import from another browser), with
the same result shapes: the sidebar readers are ported to TypeScript (`arcSidebar.ts`, `zenSession.ts`), and the
secrets (Firefox NSS, cookie values, autofill) are read natively in `apps/browser/windows/Ardia/Import*.h`. Arc for Windows
keeps `StorableSidebar.json` in its package's `LocalCache\Local\Arc`. A change to a reader here needs the same change there.

## Which file reads what

Paths are relative to the source's profile folder. All SQLite files go through `SQLiteSnapshot.swift`, which copies
the file and its WAL before opening it.

| Kind | Chromium family (Chrome, Edge, Brave, Helium, Opera, Vivaldi, Island, Dia…) | Arc | Firefox |
|---|---|---|---|
| bookmarks | `ChromiumBookmarks.swift` (parsed by Rust's `ardia_import_chromium_bookmarks`): `Bookmarks`, `AccountBookmarks` | same as Chromium | `Firefox.swift`: `places.sqlite` |
| history | `HistoryReader.swift`: `History` | same as Chromium | `HistoryReader.swift`: `places.sqlite` |
| tabs | `ChromiumSessions.swift`: newest readable `Session_*` across `Sessions/` (SNSS v3) and `Sessions_Encrypted/` (v5, Chromium 156+, needs the key; without it the cleartext copy is read), legacy `Current Session` | `ArcSidebar.swift` | `Firefox.swift`: `sessionstore-backups/recovery.jsonlz4`, `sessionstore.jsonlz4` |
| passwords | `ChromiumSecrets.swift`: `Login Data`, `Login Data For Account` (key from `ChromiumCrypto.swift`) | same as Chromium | `FirefoxLogins.swift`: `key4.db` + `logins.db` (A256GCM JWE, key labelled `as-logins-key`) merged with `logins.json` |
| cookies | `ChromiumSecrets.swift`: `Network/Cookies` (or `Cookies`) | same as Chromium | `Firefox.swift`: `cookies.sqlite` |
| autofill (addresses, cards) | `ChromiumAutofill.swift`: `Web Data` | same as Chromium | none |
| extensions (each one's on/off state and toolbar pin; Web Store ones are listed on the done screen with their store pages, the others with why: Manifest V2, unpacked, policy, added by another app, not from the Web Store; components, themes and apps are left out) | `ChromiumExtensions.swift`: `Preferences`, `Secure Preferences` (`extensions.settings`, `extensions.pinned_extensions`), `Extensions/*/manifest.json` | same as Chromium | none |
| spaces, pinnedTabs, favorites | none | `ArcSidebar.swift`: `<Application Support>/Arc/StorableSidebar.json` (a space's Icon-tab glyph name comes over as `icon`; JS maps it to an emoji, `state/import/arcExtras.ts`). Each item's icon comes first from Arc's own `Arc/SidebarItemsFaviconCache/<md5 of the item id>` (a PNG Arc drew, `ArcExtras.cachedFavicons`), then from `Favicons` | none |
| linkRules (Air Traffic Control), archive | none | `ArcExtras.swift`: `Arc/StorableLinkRouting.json` (`rules` with an `id`, exactly one `sourceComponents` `urlMatch` whose operator is `contains` or `matches`, text up to 2 KB; `destination` and `defaultDestination` are `space` or `littleArc` of `mostRecent` or a space id, kept even when the space is gone; anything else is counted in `skipped`; at most 1,000 rules), `Arc/StorableArchiveItems.json` (tabs only, web pages only, newest 1,500, with the space they left), and `autoArchiveTimeThreshold` from `~/Library/Preferences/company.thebrowser.Browser.plist`, each through `ArcExtras.boundedRead` (a regular file under a size cap, opened without following a final symlink and checked to be inside its folder). Read once per import, for the first selected profile. JS (`state/import/arcExtras.ts`) turns rules into literal "containing" and "exactly" Air Traffic Control rules (id `arc-<Arc's id>`) in the profile each space became, the archive into Recently Cleaned (its newest 100, kept a week from the import), and the threshold into the clean-up setting when that is untouched | none |
| default search engine (every import, not a kind; `ImportResult.searchEngine`) | `ChromiumSearchEngine.swift`: `Preferences` `default_search_provider.guid` (else `synced_guid`) → its `keywords` row in `Web Data`, else `default_search_provider_data.template_url_data`; none means the browser's own default; `packages/expo-windows/src/import/searchEngine.ts` reads the same on Windows. JS maps it onto a built-in or custom engine and switches to it only while the user hasn't chosen one, else offers it (`apps/browser/src/state/import/searchEngine.ts`) | same as Chromium | none |
| favicons (for the imported tabs, favourites and bookmarks-bar links) | `ChromiumFavicons.swift`: `Favicons` (the page's own icon, else another page of the same site's; one PNG near 32 px, 16 KB each, up to 1,000 pages and 6 MB) | same as Chromium | `FirefoxFavicons.swift`: `favicons.sqlite` (`moz_icons` through `moz_icons_to_pages` and `moz_pages_w_icons`; the page's own icon, else its site's root icon (a `root = 1` row whose URL is http(s), path `/favicon.ico`, no query, fragment or user, same host and port, `www.` and the scheme aliased), else the site's home page's, else the site's most recently visited pages' by `places.sqlite` `last_visit_date`; only a PNG blob whose own IHDR says both sides are 1 to 64 px, widest first, whatever the `width` column claims; SVGs and other formats are never decoded and are skipped, so the page loads its own; 16 KB each; up to 1,000 fragment-free addresses and 6 MB together with the session icons Zen already gave, which win). `firefoxFavicons.ts` on Windows applies the same rules |

| Source | Files | What it reads |
|---|---|---|
| Discovery (which browsers and profiles exist) | `Discovery.swift` (`BrowserDefinition.all`: IDs, data paths, Keychain items; each release channel with its own data folder, like Brave Beta or Edge Canary, is its own source and shares the vendor's Keychain item), `AppIcons.swift` | Chromium `Local State`; Firefox `profiles.ini` (`Firefox.profiles`) |
| Zen | Same as Firefox (`zen/profiles.ini`, family `firefox`, `sidebar: zen`), plus `ZenSidebar.swift` for spaces, pinnedTabs, tabs, favorites (Essentials) and session tab icons; `FirefoxFavicons.swift` fills in the icons the session lacks (Essentials, pinned tabs, folders, the bookmarks toolbar) | `zen-sessions.jsonlz4`, then `zen-sessions-backup/clean.jsonlz4` and the newest `zen-sessions-*.jsonlz4`, then the Firefox session store (windows carry `spaces` and `folders`; before Zen 1.18 the workspaces are only in `places.sqlite` `zen_workspaces`). Each space carries its `containerTabId` and each Essential its `userContextId`, `prefs.js` says whether Essentials are per container, and `containers.json` names the containers; JS (`state/import/sidebarPlan.ts`) gives each container its own profile |
| Dia | Same as the Chromium family (`Dia/User Data`), except its tabs, pinned tabs and favourites, which come from its sidebar file (next row) or, without one, from Dia itself (the row after; `asksAppForTabs` on the source) | |
| Dia sidebar (tabs, pinnedTabs, favorites of a profile with `diaSidebar`) | `DiaSidebar.swift` (`DiaDatabase` decrypts; needs the Safe Storage key, so such a profile has `tabsNeedKey`) | `<profile>/tabs.db` and `tabs.db-wal`: SQLCipher 4 (4096-byte pages, 80 reserved bytes, AES-256-CBC per page), key HKDF-SHA256 of the Chromium key with the label `profile/<folder>/tabs`; the -wal's committed frames are folded in and the result is opened in memory only. Each Dia space becomes a `SpaceSuggestion`: `favorites`, `pinned` (folders nest, a split is a `split` folder), `tabs` (ungrouped open tabs, splits marked by `splitId`) and `openGroups` (open-tab groups as folders); folders carry `icon` (emoji) and `color` (a tab group colour). The result's `diaSidebar` (`primarySpaceId`, the space that goes to the chosen profile, taken before the kinds are filtered) is set only when the file was read, so a read that came from Dia's session instead falls back. JS: `importDiaSpace` in `state/import/sidebarTree.ts`; a profile whose file doesn't read falls back to Dia's AppleScript (`state/import/runImport.ts`). The file format and its key were first worked out by Victor Kildahl's Cra ([VictorKildahl/cra#79](https://github.com/VictorKildahl/cra/pull/79), MIT); our reader is our own code |
| Dia open and pinned tabs, for a profile without a readable sidebar file (part of the Dia import) | `DiaAppleEvents.swift` (`DiaTabsFetch`: opens Dia hidden and unactivated if it isn't running, asks it, quits it again; Apple Events under the `DiaAutomation` permission) → `DiaTabs.swift` (`DiaTabsImport.build`) | Each Dia window's tabs over AppleScript; needs Automation permission, and Dia already running is left running; their icons come from every Dia profile's `Favicons` (`Importer.favicons`). JS matches each Dia profile to the profile on disk with the same name (else the same position) and adds its tabs to that profile's destination; a Dia profile with tabs and no folder on disk gets a new profile of its own (`state/import/diaTabs.ts`). Every Dia profile is selected by default |
| Safari direct (needs Full Disk Access) | `SafariDirect.swift`, `SafariCookies.swift` | `~/Library/Safari/{Bookmarks.plist, History.db, LastSession.plist}`, `~/Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies` |
| Safari export (.zip or folder) | `SafariExport.swift`, `ZipArchive.swift`, `NetscapeBookmarks.swift`, `PasswordsCSV.swift` | `*.html` bookmarks, `*.csv` passwords, `*.json` history and extensions (names only, by `metadata.data_type`), `payment_cards` JSON. No cookies |
| A bookmarks HTML file or passwords CSV | `NetscapeBookmarks.swift`, `PasswordsCSV.swift` | Any Netscape bookmarks file; any password CSV with url and password columns (Chrome, Firefox, Bitwarden…) |

Shared code: `Model.swift` (`ImportKind`, `ImportResult` and the other result types, `ImportError`), `ChromiumCrypto.swift`
(v10 AES-CBC, `SafeStorageKeychain`), `SecretBytes.swift` (wipeable buffers), `Wire.swift` (JSON for the engine).

## Data flow

1. `Discovery.swift`: `BrowserDiscovery.list()` returns each installed source and its profiles (`listBrowsers`).
2. `Importer.swift`: `Importer.importData(browserId:profileId:kinds:…)` dispatches on `(kind, family)` to the readers
   above. A failed kind becomes a warning plus an entry in `failed`, and the other kinds still run. Safari, Dia tabs,
   HTML and CSV have their own module functions (`importSafariDirect`, `importSafariExport`, `readDiaTabs`,
   `importBookmarksHTML`, `importPasswordsCSV`).
3. `ios/ImportModule.swift` (Expo module `ArdiaImport`) encodes the result as a JSON string for JS. It keeps
   cookies, addresses and cards back in `ImportVault` (`ios/ImportWriter.swift`) and returns only their counts and
   a one-time `vaultToken`. History can stream in chunks (`onImportEvent`).
4. `ios/ImportWriter.swift`: `writeImported(token, engineProfile, kinds)` takes the vault entry and sends it to the
   engine with `ArdiaEngineBridge.callWithSecret` as `ac_cookies_import` and `ac_autofill_import`, in batches of 500
   (`engine/chromium/src/chrome/browser/ardia/ac_cookies.cc`, `ac_autofill.cc`).
5. `apps/browser/src/components/import/ImportWindow.tsx` is the wizard: choose, then profiles, then unlock, then
   progress, then done. `apps/browser/src/state/import/apply.ts` writes the JS-side kinds into the store (bookmarks, history, tabs, Arc spaces,
   Dia profiles) and saves passwords with `savePassword` (`@ardia/ardiacore`). For cookies and autofill it calls
   `importNative`, which calls `writeImported`. Before any tab is made, the result's `favicons` for the pages that
   profile gets go to `adoptFavicons` (`apps/browser/src/state/favicons/favicons.ts`): into the sidebar's icon cache at once, and
   into the profile's Chrome favicon database with `ac_favicons_set`, so they survive a relaunch without a page load.
   `apps/browser/src/platform/importModule.ts` loads the package lazily.
6. Extensions: `listExtensions(browserId, profileId)` returns every extension of a source profile with whether the user
   turned it off there (`DISABLE_USER_ACTION`, 1 << 0, in the `disable_reasons` list or the legacy bitmask), its toolbar
   pin and, when it can't come from the Chrome Web Store, why (`skip`). Only an explicit internal location (a JSON
   integer 1) with `from_webstore` a JSON `true` counts as the Web Store, and a malformed id is dropped.
   `apps/browser/src/state/import/extensionListing.ts` plans the done screen's list: every Web Store extension under the
   Ardia profile its source profile went to, by the name the source lists, its id and a store link built from the id,
   leaving out what that profile already has (`listedExtensions.ts` reads `extensions.list`). Nothing is installed:
   installing from the import waits on an engine op that can create an install only if absent, own it, and cancel it for
   good. Linux's reader (`ac_linux_import_readers.cc`) sends only the id, name and store link, so Linux keeps the plain
   store-link list.

## Secrets and the Keychain

- Chromium-family passwords, cookies and card numbers are encrypted with the browser's "`<Name> Safe Storage`"
  Keychain item. `SafeStorageKeychain.secret` reads it, and macOS shows a system prompt when it does. It runs only from
  `unlockBrowser`, after the user goes through the unlock step (`ENCRYPTED` kinds in `ImportWindow.tsx`).
- **Agents never trigger it.** The Swift tests pass the fixture key (`Fixtures.chromiumKey`, `importer.setKey`),
  and app runs set `ARDIA_TEST` `importSecret`. Firefox has no Keychain item; its primary password goes through
  `unlockBrowser(id, { primaryPassword })`.
- Cookie values, addresses and card numbers never reach JS. `ImportResult` and `SafariExport` leave them out of their
  `CodingKeys` and encode only the counts. They're held in `SecretBytes`; `Wire.swift` serialises them into
  `SecretBytes` too, and `ImportWriter` copies that once into the buffer the bridge zeroes after the call. Vault entries expire after 10 minutes. JS drops the token for a private profile.
- Passwords do reach JS (`credentials`), because `savePassword` takes them from there.
- `forgetUnlockedKeys` drops the derived keys and the whole vault.

## Fixtures

`pnpm --filter @ardia/import fixtures` runs `fixtures/generate.py`, which wipes `fixtures/home/` and
`fixtures/misc/` and rebuilds everything below deterministically. The test secrets are in `fixtures/secrets.json`.
`fixtures/dia/` and `fixtures/extensions/` are written by hand. Don't open the Firefox `places.sqlite` with the
sqlite3 CLI: it checkpoints the WAL the tests depend on.

| Function | Writes (under `fixtures/`) |
|---|---|
| `build_chrome` | `home/Library/Application Support/Google/Chrome/` (Default + Profile 1, each with extensions and toolbar pins from `chrome_extensions`: Web Store ones on and off, a Manifest V2, an unpacked and a policy one), `misc/Cookies-v23`, `misc/Session_v5_encrypted`. Default's search engine is a custom one (`keywords` in `Web Data`) |
| `build_brave` | `home/Library/Application Support/BraveSoftware/Brave-Browser/` |
| `build_opera` | `home/Library/Application Support/com.operasoftware.Opera/` (the root is the profile) |
| `build_helium` | `home/Library/Application Support/net.imput.helium/` |
| `build_dia` | `home/Library/Application Support/Dia/User Data/` (Default + Profile 2; `build_dia_sidebar` writes Default's encrypted `tabs.db` and a `tabs.db-wal` with one committed and one unfinished edit; Profile 2 has none, like an older Dia) |
| `build_safari_direct` | `home/Library/Safari/{Bookmarks.plist, History.db, LastSession.plist}` |
| `build_safari_cookies` | `home/Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies`, `misc/binarycookies/*` (malformed) |
| `build_arc` | `home/Library/Application Support/Arc/` (`User Data/`, `StorableSidebar.json`). Default searches with DuckDuckGo (`keywords` in `Web Data`), Profile 1 with Arc's own default |
| `build_zen` | `home/Library/Application Support/zen/` (`profiles.ini`, a current profile with `zen-sessions.jsonlz4`, `logins.db` and `logins.json`, a legacy one with spaces only in the Firefox session, one recovered from a backup, one without spaces; the current one has a `favicons.sqlite` with a `www.` root icon, an SVG, a 128 px-only icon and a broken SVG) |
| `build_firefox` | `home/Library/Application Support/Firefox/` (`profiles.ini`, `Profiles/*`, a `favicons.sqlite` with a page's own icons in three widths, a root `favicon.ico`, an SVG and another page of a site), `misc/nss-legacy-pbe.json` |
| `build_exports` | `safari/Safari Export/`, `safari/Safari Export.zip`, `safari/not-an-export.zip`, `csv/*.csv`, `html/chrome-bookmarks.html` |

## Commands

| What | Command |
|---|---|
| Swift tests (`tests/`, against `fixtures/`) | `pnpm --filter @ardia/import test` (`swift test`, scratch path in `$TMPDIR`) |
| Rebuild fixtures | `pnpm --filter @ardia/import fixtures` |
| Typecheck the JS wrapper | `pnpm --filter @ardia/import typecheck` |
| End to end in a hidden Debug instance (cookies, addresses, cards) | `node packages/import/scripts/e2e.mjs <Ardia.app> <scratch dir>` (`--help`) |
| Run one script in that instance (`e2e.mjs --keep`) | `scripts/agent/ac eval <scratch dir>/data '<js>'` |

## Test hooks (`ios/ImportModule.swift`)

| Key | Effect |
|---|---|
| `ARDIA_INSTANCE` `importSourceDir` | Discovery reads browsers from this folder instead of `~/Library/Application Support`. Point it at `<fake home>/Library/Application Support` |
| `ARDIA_INSTANCE` `importSafariHome` | Safari direct reads from this home. If it isn't set, the home is two levels above `importSourceDir`, and only when that is set |
| `ARDIA_TEST` `importSecret` | `unlockBrowser` uses this as every browser's Safe Storage secret and never touches the Keychain (test instances only) |
| `ARDIA_TEST` `importDiaBundleId` | Dia's tabs come from this app instead of `company.thebrowser.dia`: it's the one opened and quit, and discovery offers the tabs when it's installed (test instances only) |
| `ARDIA_TEST` `importDiaWindows` | A JSON file of `DiaScript.Window`s (`fixtures/dia/applescript-windows.json`) answers in place of the Apple Events, and Automation consent counts as given, so no macOS prompt shows; the app from `importDiaBundleId` is still opened and quit (test instances only) |

## Adding a source or a kind

1. **Source**: add a `BrowserDefinition` to `BrowserDefinition.all` in `Discovery.swift`. A Chromium fork usually
   needs only `chromium(id, name, bundleIds, dataPath, keychainName)`. A new family needs a case in
   `BrowserDiscovery.source` and in `Importer.unlock`.
2. **Kind**: add the case to `ImportKind` (`Model.swift`) and to the `ImportKind` union in `src/index.ts`, plus a
   result field on `ImportResult` and its TS type. If the kind carries secrets, leave it out of `CodingKeys`, encode a
   count instead, and keep it in `ImportVault`.
3. Write the reader in `ios/Core/<Source><Kind>.swift`. Read SQLite through `SQLiteSnapshot`, check `cancellation`,
   and throw `ImportError`. Then add its `(kind, family)` case in `Importer.importData`.
4. Add a fixture: a `build_*` function in `fixtures/generate.py`, or a branch of an existing one. Run
   `pnpm --filter @ardia/import fixtures` and write a test in `tests/`.
5. Apply it in the app. Add the kind to `IMPORT_KINDS` (and `ENCRYPTED_KINDS` if it's encrypted) in
   `apps/browser/src/state/import/flow.ts`, its title and icon to `KIND_LOOK` in `components/import/model.ts`, and write
   it in `state/import/apply.ts`. A secret kind goes through `ImportWriter` and a new engine call instead.
6. Run `test`, `typecheck` and `pnpm -w typecheck`. For anything that reaches the engine, also run `scripts/e2e.mjs`
   against a fresh Debug build.
