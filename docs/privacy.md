# Privacy: what Ardia itself contacts

This is the list of every host Ardia (not the pages you open) talks to, how each request travels, and every Google or
Chromium service that is turned off. `apps/browser/src/privacyEndpoints.test.mjs` keeps it honest: it scans the
shipped sources of the Mac, Linux and Windows apps for hard-coded `http(s)://` and `ws(s)://` hosts and fails when one
isn't on this page (in native and engine code also a quoted bare host, such as a redirect allowlist entry; in a patch, the lines it adds and the context it keeps), and it fails when a row below cites a file that's gone or a literal that's no longer in it.
Reserved names (`.example`, `.test`, `.invalid`, `.localhost`, `.local`) and the loopback addresses (`127.x.x.x`, `0.0.0.0`) are skipped; any other IP literal must be listed like a host; tests, fixtures,
build scripts and docs aren't shipped and aren't scanned.

## How requests travel

- **The profile's Chromium network context.** Chromium's own stack for that profile: it follows the system proxy, an
  extension's `chrome.proxy` setting and a `ProxySettings` policy for that profile, and it can send that profile's
  cookies. A private window's profile is its own off-the-record context. There is no Ardia proxy setting: `ACMainDelegate`
  strips `--proxy-server` and `--proxy-pac-url` from the command line (`engine/ardiacore/src/ardia/core/ac_main_delegate.cc`,
  `docs/engine-build.md`), so Chromium follows the system proxy.
- **Chromium's system network context.** Chromium's stack with no profile: system proxy and policy, no profile's
  cookies, no extension proxy. The Linux app sends its own requests (telemetry, reports, updates, kill switches, the
  bang list) this way, with credentials omitted.
- **URLSession and the app's `fetch`.** Requests outside Chromium (React Native's `fetch` is `NSURLSession` on
  the Mac; the desktop shells on Linux and Windows make theirs through Chromium). They follow the system proxy, but no extension or Chromium policy proxy,
  and they belong to no profile: they never carry a site's Chromium cookies. Ardia's own URLSession sessions are
  ephemeral with no cookie store.
- **`NWConnection`.** Plugins' `net.fetch` opens its own TLS connection after checking the resolved address, so it
  doesn't go through any HTTP proxy.

## Endpoints Ardia contacts

| Host | Purpose | Stack | System proxy | Private windows | Other profiles | Cookies and credentials | Gate | Off switch | Code |
|---|---|---|---|---|---|---|---|---|---|
| `ardia.dev` | Usage counts and crash reports (`/otel/v1/logs`), everything but the daily count below | App `fetch` (Mac, Windows); Chromium system context (Linux) | Yes | App-wide counts; a private window adds to counts, never a URL or a title | App-wide, no profile | No Chromium cookies; an ingest key header that is the same in every copy of Ardia, not a per-user credential | Sharing on only | Settings › General › Share anonymous crash reports | `apps/browser/src/state/telemetry/config.ts`, `engine/ardiacore-desktop/src/ardia/desktop/ac_desktop_telemetry_policy.h` |
| `ardia.dev` | One anonymous "opened today" count a day (`daily_active` to `/otel/v1/logs`): app version, update channel, OS version, chip, and whether it's this copy's first day, week or month, with no persistent id | App `fetch` (Mac, Windows); Chromium system context (Linux) | Yes | App-wide, nothing from any window | App-wide | No Chromium cookies; the same app ingest key | Sent by release builds whatever the sharing choice (Settings says so beside the switch); development builds and isolated test instances don't send it by default, unless the `telemetry` dev test value is set to `1` (`DEV_SEND_TEST_KEY`) | None in Settings: turning sharing off doesn't stop it | `apps/browser/src/state/telemetry/daily.ts`, `apps/browser/src/state/telemetry/transport.ts`, `apps/browser/src/state/telemetry/config.ts` |
| `ardia.dev` | Kill switches (`/switches.json`), once a launch | App `fetch` with `credentials: "omit"`; Chromium system context (Linux) | Yes | App-wide, nothing from the window | App-wide | None (credentials omitted) | Automatic update checks on | Settings › General › Install updates automatically | `apps/browser/src/platform/killSwitches.ts`, `engine/ardiacore-linux/src/ardia/linux/ac_linux_updates_policy.h` |
| `ardia.dev` | Update feed (`/appcast.xml`), Sparkle on the Mac | Sparkle's URLSession | Yes | App-wide | App-wide | No Chromium cookies | Automatic update checks on, or Check for Updates | Settings › General › Install updates automatically | `apps/browser/macos/Ardia-macOS/Info.plist` |
| `ardia.dev` | Reports you send (`/api/feedback`); every report carries the install and session ids (`install_id`, `session_id`) whatever you attach; attachments go to the upload addresses it hands back | App `fetch`, attachments over an ephemeral URLSession (Mac); Chromium system context (Linux) | Yes | Can be sent from a private window: you write it and pick what to attach, which may include the current page's address | Only what you attach | No Chromium cookies; the same app ingest key | You press Send | Don't send a report | `apps/browser/src/state/report/actions.ts`, `engine/ardiacore-desktop/src/ardia/desktop/ac_desktop_report_core.h` |
| `github.com`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com` | Update downloads (GitHub redirects release assets to its asset hosts; Linux and Windows allow only these three), the Windows and Linux update feeds, official plugin downloads | Sparkle's URLSession (Mac), Chromium system context with credentials omitted (Linux and Windows), ephemeral URLSession (plugins) | Yes | App-wide | App-wide | None | Updates: automatic checks or Check for Updates; plugins: you install or update one | Install updates automatically; don't install the plugin | `apps/browser/official-plugins.json`, `packages/shell/ios/AppUpdater.swift`, `engine/ardiacore-linux/src/ardia/linux/ac_linux_self_update_policy.h`, `scripts/windows/engine/src/ardia/win/webui/webui_updates.cc`, `scripts/windows/engine/src/ardia/win/webui/webui_update_policy.h` |
| `api.github.com` | Linux release list for updates | Chromium system context | Yes | App-wide | App-wide | None | Automatic update checks on | Install updates automatically | `engine/ardiacore-linux/src/ardia/linux/ac_linux_updates_policy.h` |
| `services.helium.imput.net` | The `!bang` list (`/bangs.json`), refreshed at most once a day when you type `!`; no query is sent | Ephemeral URLSession with no cookies (Mac), Chromium system context (Linux and Windows) | Yes | Any window can start it, a private one included: typing `!` there can start the once-a-day refresh of the public list, with no query, no cookies and no profile | App-wide | None | You type `!` in the address bar | None; the bundled list works offline | `packages/shell/ios/BangListFetch.swift`, `engine/ardiacore-desktop/src/ardia/desktop/ac_desktop_bang_list_policy.h` |
| `www.google.com`, `api.bing.com`, `duckduckgo.com`, `ac.ecosia.org`, `search.brave.com`, `www.startpage.com`, `search.yahoo.com`, `www.baidu.com`, `suggest.yandex.com` | Search suggestions from the profile's search engine as you type | The window profile's Chromium network context | Yes, plus extension and policy proxies | Off | Each window asks with its own profile | Mac and Windows: that engine's own cookies from the profile, as Chrome does, never saved; Linux: none | Suggest while typing on | Settings › Profiles › Suggest while typing | `packages/core/src/engines.ts`, `engine/chromium/src/chrome/browser/ardia/ac_search_suggest.cc`, `engine/ardiacore-desktop/src/ardia/desktop/ac_desktop_suggest_policy.h` |
| A page's icon host (from the page) | The icon a page reports, and the icon the app fetches when Chromium hasn't stored one | The tab's own profile's network context (a private tab's is its off-the-record one, as for the page's own requests) | Yes, plus extension and policy proxies | A private tab's reported icon loads through its own off-the-record profile and the app fetches no missing icon for it; the private window reads regular profiles' local icon stores read-only (see below, #3837) | Only the tab's own profile fetches | Mac: no cookies (the profile's icon fetcher); Linux: Chromium's page image download from the tab, which can send the tab profile's cookies for that host like the page's own requests | Shown tabs only | None | `packages/ardiacore/ios/ArdiaFavicons.mm`, `apps/browser/src/state/favicons/favicons.ts`, `engine/ardiacore-linux/src/ardia/linux/ac_linux_favicons.cc` |
| A search engine's or scoped site's host (from the engine or page) | `https://<host>/favicon.ico` for the icons in Settings › Profiles › Search and the address bar's scope chip, when no bundled or stored icon exists | The given profile's Chromium network context (Default in Settings, the window's own in the address bar) | Yes, plus extension and policy proxies | Not fetched for a private window's profile | That profile only | No cookies | The row is shown | None | `apps/browser/src/components/favicon/Favicon.tsx`, `apps/browser/src/components/settings/panes/ProfileSearch.tsx` |
| Media artwork hosts (from the page) | The artwork a playing page names for its media, shown in Ardia's media controls | The tab's own profile: on the Mac its icon fetcher (`ArdiaFavicons`), on Linux Chromium's page image download; Windows loads none | Yes, plus extension and policy proxies | A private tab's artwork loads through its own off-the-record profile, as the page's own requests | The tab's own profile only | Mac: no cookies; Linux: may send the tab profile's cookies for that host | Media is playing | None | `apps/browser/src/state/media/artwork.ts`, `packages/ardiacore/ios/ArdiaWebView+PageCommands.mm` |
| Website notification icons (from the page) | The icon of a site's notification | The tab's own profile's Chromium network context, then a local file or `data:` image; the notification layer refuses anything else | Yes | Private windows post no notifications | The tab's own profile only | No cookies (Mac); Windows and Linux attach no site icon through this path | The site has notification permission | Block the site's notifications | `apps/browser/src/state/site/webNotifications.ts`, `packages/shell/ios/NotificationHub.swift` |
| Filter list hosts (from the bundled uBlock Origin's asset manifest) | uBlock Origin refreshes the stock lists that are turned on (EasyList, EasyPrivacy, uBO's own, regional, cookie and annoyance lists) from the hosts its pinned release names, on its own update schedule | uBlock Origin, a component extension in each regular profile, on that profile's Chromium network context | Yes, plus extension and policy proxies | One instance serves the profile and its private windows (`incognito: spanning`), so refreshes run in the regular profile, not for a private window | Each regular profile refreshes its own lists | Chromium's rules for an extension's requests | The list is turned on (several are on by default) | Settings › Privacy › Advanced Ad Block Settings, turn the list off | `packages/ardiacore/scripts/ubo.sh`, `packages/ardiacore/ios/ArdiaContentBlocker.mm` |
| Your filter lists' hosts (user-added) | A list you add by address in Settings › Privacy › Advanced… › Your lists is downloaded at once and refreshed with the others (Mac and Linux, Chromium tabs only) | Same as the stock lists | Yes, plus extension and policy proxies | Same as the stock lists | Every profile copies the default profile's added lists | Chromium's rules for an extension's requests | You add the list | Remove it from Your lists | `packages/ardiacore/ios/ArdiaContentBlocker.mm` |
| Apple's Safe Browsing service for WebKit pages (from the system's WebKit, not named in Ardia's code) | Checks a WebKit page's address against Google's or Tencent's Safe Browsing lists through Apple's service, and warns before a deceptive site opens (macOS 15.4+, WebKit tabs only) | WebKit's own networking | Yes | Applies to every WebKit view, private ones included, while it's on | App-wide | None of the profile's cookies; Apple's service, not the site | Off until you turn it on | Settings › Advanced › WebKit pages › Warn about fraudulent websites | `packages/ardiacore/ios/WebKitFraudWarnings.swift`, `apps/browser/src/components/settings/rows/advancedRows.ts` |
| `clients2.google.com`, `chromewebstore.googleapis.com` | Chrome Web Store installs, extension updates, Google's extension kill switch, and the store's item details for an install prompt | Chromium's extension downloader on the profile's network context | Yes, plus extension and policy proxies | Chromium's rules: updates are per regular profile | Per profile | Chromium's rules: retries with the profile's Google cookies only when the store asks for them | You install an extension | Remove the extensions | `engine/patches/chromium-webstore-direct.patch`, `engine/patches/chromium-extension-updates.patch` |
| `update.googleapis.com`, `dl.google.com`, `gvt1.com` | Security components only: CRLSet, PKI metadata (CT logs, root store), the SSL error assistant. The update check is `update.googleapis.com`; the downloads it answers with come from `dl.google.com`, Google's `gvt1.com` mirrors (such as edgedl.me.gvt1.com) or `www.google.com/dl/`, the only download hosts the patch accepts | Chromium's component updater, system context | Yes | App-wide | App-wide | None | Always | None | `engine/patches/chromium-component-updater-security-only.patch` |
| `api.github.com`, `github.com`, `api.bitbucket.org`, `bitbucket.org`, `api.notion.com`, `oauth2.googleapis.com`, `www.googleapis.com` | Live Folders: your GitHub, Bitbucket, Notion and Google Drive items, and signing in to them | App `fetch` (Mac, Windows); the app profile's Chromium context with credentials omitted (Linux) | Yes | Refused in private windows | The account you connected, app-wide | The token you granted, no cookies | You connect an account | Settings › Automations › Connected accounts | `apps/browser/src/state/live/net.ts`, `apps/browser/src/state/live/sources.ts`, `engine/ardiacore-linux/src/ardia/linux/ac_linux_live.cc` |
| Images the provider links (Notion page icons, GitHub and Bitbucket avatars, such as GitHub's avatar host) | Icons and avatars in Live Folder rows, pull request previews and Connected accounts, loaded from the address the provider's reply gives | React Native's image loader (`NSURLSession` on the Mac, `Windows.Web.Http` on Windows); not loaded on Linux, whose shell allows only its own and `data:` images | Yes | Live Folders don't run in private windows | App-wide | No Chromium cookies; the image loader's own cache | You connect an account and its items are shown | Disconnect the account | `apps/browser/src/components/sidebar/LiveItemRow.tsx`, `apps/browser/src/components/live/LiveItemCard.tsx` |
| Your Confluence site (user-chosen) | Live Folders for Confluence | App `fetch` | Yes | Refused in private windows | App-wide | The token you granted | You connect it | Disconnect it | `apps/browser/src/state/live/sources.ts` |
| Hosts a plugin declares (plugin-chosen) | A plugin's `net.fetch`, https only, to the hosts in its manifest | `NWConnection` (Mac) | No: direct | Not tied to a window | App-wide | Only what the plugin sends | The plugin has the network permission and you installed it | Remove or turn off the plugin | `packages/shell/ios/PluginHostFetch.swift`, `apps/browser/src/state/plugins/channelData.ts` |
| Your omnibox provider's host (user-chosen) | A suggestion provider you added in config | App `XMLHttpRequest`, `withCredentials = false` | Yes | Off | Per profile cache | None | You approve the provider | Remove it from config | `apps/browser/src/state/omnibox/remoteProvider.ts` |
| `chromeuxreport.googleapis.com` | Real-user field metrics for the origin a `devtools.perfTrace` call traced, read from the tab after the trace ends: only the origin, never a path or query, with the caller's own API key; skipped when the page changed origin during the trace | App `fetch` with `credentials: "omit"` | Yes | Never for a private window's page | Not tied to a profile | None (credentials omitted); the API key the caller passed | Only when a control-socket caller sets `includeFieldData` and gives `fieldDataKey`; off otherwise | Don't pass `includeFieldData` | `apps/browser/src/state/automation/devToolsFieldData.ts` |

Sync makes no network request: it writes sealed files to a folder you pick and the folder's own service carries them
(`docs/sync.md`). The phone app (`apps/phone`) is out of scope here; `docs/phone.md` covers it.

### Private windows and other profiles

- Nothing outside Chromium starts by itself from a private window, with one exception: suggestions, providers,
  plugins' omnibox rows, Live Folders, notifications and the app's missing-icon fetches are all off there, but typing
  `!` can start the bang list's once-a-day refresh (the `services.helium.imput.net` row: a cookie-free, query-free
  fetch of the public list, outside any profile). Report a Problem can also be sent from one: you write it and pick
  its attachments.
- A private window shows the icons the regular profiles have for its pages (as Chrome's incognito shows the original
  profile's), and its own tabs' icons. To find them it reads each regular profile's local icon store, with no network,
  through `favicons.peek` (`ac_favicons_peek`, #3837). The read is read-only: it doesn't mark the icon used
  (`last_requested`), update a page's icon mapping or schedule a commit. It is answered only by a regular profile
  that is already loaded with its history database open, so it never loads a profile or opens, creates or migrates a
  favicon database. Every icon drawn inside a private window uses it, including the rows (bookmarks, history) that
  name a regular profile. The answers stay in that window's own icon cache, which leaves with the window, and never
  enter the regular profiles' caches. On Windows, until its engine has the call (#3881), the read falls back to `ac_favicons_get`
  and still marks the icon used, as on main, so private windows there keep their icons. `packages/ardiacore/scripts/favicon-peek-check.mjs` checks on a hidden instance that the regular
  profile's `Favicons` file keeps its size, modification time and `last_requested`.
- A private window's own icons, and the themes and accents worked out from them, leave Ardia's icon caches when it
  closes, even an icon that already left the cache before; a theme or accent asked for one after the close is never
  requested. The native process-wide image caches (the Mac's icon cache of images Chromium reported, artwork, the
  dock's blurred backdrops) evict on their own and aren't cleared at close.
- A normal window drawing an icon with no profile given (the command bar, history menus) may ask any regular profile's
  local icon store. Chromium then marks that icon used in the profile that answered.

## Hosts named in the source that Ardia doesn't contact

Pages, links and patterns: Ardia opens these only as pages you navigate to, or matches them as text.

- Search engines' result pages (searches open as pages): `www.google.com`, `www.bing.com`, `duckduckgo.com`,
  `www.ecosia.org`, `search.brave.com`, `www.startpage.com`, `search.yahoo.com`, `www.baidu.com`, `yandex.com`,
  `kagi.com`, `www.perplexity.ai`, `chatgpt.com`, `claude.ai`.
- Site search and quick-create shortcuts: `developer.mozilla.org`, `en.wikipedia.org`, `hn.algolia.com`, `mail.google.com`,
  `drive.google.com`, `open.spotify.com`, `stackoverflow.com`, `translate.google.com`, `www.amazon.com`, `www.ebay.com`,
  `www.figma.com`, `www.imdb.com`, `www.linkedin.com`, `www.notion.so`, `www.npmjs.com`, `www.pinterest.com`,
  `www.reddit.com`, `www.youtube.com`, `x.com`, `confluence.new`, `docs.new`, `excel.new`, `figjam.new`, `figma.new`,
  `forms.new`, `gist.new`, `jira.new`, `linear.new`, `meet.new`, `meeting.new`, `notion.new`, `powerpoint.new`,
  `repo.new`, `sheets.new`, `slides.new`, `word.new`.
- The bundled `!bang` list (`packages/core/src/bangList.ts`, generated from Helium's list, about 10,700 entries) is
  not scanned and its hosts aren't listed here: each entry is a search page a bang opens as a page you navigate to,
  stored without a scheme, and Ardia never contacts one by itself. The list's own refresh is the `services.helium.imput.net` row above.
- Onboarding's suggested sites (bundled icons, nothing fetched): `app.slack.com`, `calendar.google.com`,
  `docs.google.com`, `linear.app`, `outlook.office.com`.
- Links Ardia opens as pages: `chromewebstore.google.com` and `chrome.google.com` (an extension's store page),
  `accounts.google.com` (Google's sign-in page for Live Folders, opened in a tab), `www.atlassian.com`,
  `your-team.atlassian.net` (a placeholder), `crbug.com`.
- Streaming sites matched by name for DRM and media handling (`packages/ardiacore/ios/ArdiaPopupWindow.mm`,
  `WebKitMediaFaults.swift`): `netflix.com`, `disneyplus.com`, `max.com`, `hbomax.com`, `primevideo.com`, `hulu.com`,
  `tv.apple.com`, `music.apple.com`, `peacocktv.com`, `paramountplus.com`, `crunchyroll.com`, `hotstar.com`,
  `jiohotstar.com`, `v.qq.com`, `audible.com`, `audible.co.uk`, `audible.ca`, `audible.com.au`, `audible.de`,
  `audible.fr`, `audible.it`, `audible.es`, `audible.co.jp`, `audible.in`, `audible.com.br`, `canalplus.com`,
  `mycanal.fr`, `tv.youtube.com`, `osnplus.com`, `anghami.com`.
- Hosts a check refuses: `metadata.goog` (plugins' `net.fetch` never reaches cloud metadata), `google.com` (matched in
  the Web Store patch's checks).
- XML and schema namespaces, never fetched: `www.w3.org`, `www.apple.com`, `schemas.microsoft.com`, `json-schema.org`.
- Licence text: `www.apache.org`, `www.gnu.org`, `fsf.org`.
- Placeholders: `example.com`, `other.org`, `xn--bcher-kva.de` (the plugin broker's URL parser cases), and Helium's
  unresolvable services host `services-disabled.qjz9zk`.
- Single-label placeholders: `x` (a probe address the hook file's rewrite check parses, never fetched).
- Hosts Helium's code would use, still in the patches' context lines but replaced: `push.helium.computer` (its push
  server, swapped for the placeholder), `clients2.9oo91e.qjz9zk` (Google's crash upload, already unresolvable).
- Not hosts, method names that read like one: `engine.info`, `host.info`.

## Google and Chromium endpoints that are off

Ardia's engine is Chromium with Helium's and ungoogled-chromium's patches (pinned in
`engine/patches/build/helium-pins.ini`) and our own series. Helium's domain substitution rewrites Google hosts in
Chromium's source to unresolvable `*.qjz9zk` names, except the Web Store and extension update hosts listed in
`domsub-keep-store.txt`; that covers the many services ungoogled-chromium removes (Google sign-in and sync, metrics
upload, variations, Safe Browsing lookups, Translate, spell-check downloads, Google host detection, network time,
domain reliability, GCM). Each row cites the file that turns it off and a literal the test finds in its shipped lines (for a patch: the lines it adds or keeps; "removes" means a line it takes out). This is a citation check: it proves the cited change is still there, not that the service is unreachable at run time.

| Endpoint | What it was | Off by | Proof |
|---|---|---|---|
| Google hosts in Chromium's source | Every Google service Helium's list names | `engine/patches/build/03-helium.py`, `engine/patches/build/domsub-keep-store.txt` | `domain_substitution.py` |
| Google APIs (keys and OAuth client) | Sign-in, sync and Google API calls | `engine/patches/build/gn_defines.sh` | `google_api_key=""` |
| Safe Browsing (`safebrowsing.googleapis.com`) in Chromium | URL reputation lookups for Chromium tabs (WebKit tabs have their own opt-in check, listed above) | `engine/patches/build/gn_defines.sh` | `safe_browsing_mode=0` |
| Field trial config | Chromium's built-in experiment config | `engine/patches/build/gn_defines.sh` | `disable_fieldtrial_testing_config=true` |
| Chrome Remote Desktop and Hangouts services | Remoting host and the Hangouts extension | `engine/patches/build/gn_defines.sh` | `enable_remoting=false` |
| Chrome's own updater | Google Update / Keystone | `engine/patches/build/gn_defines.sh` | `enable_updater=false` |
| Helium's services (`services.helium.imput.net` from the engine), its update feed and crash server | Helium's services and updates | `engine/patches/chromium-helium-branding.patch` | `services-disabled.qjz9zk` |
| Helium's onboarding consent | The page that turns Helium's services on | `engine/patches/chromium-helium-onboarding-off.patch` | removes `//components/helium_onboarding:generated_resources` |
| Helium's services settings page | Switches for Helium's services | `engine/patches/chromium-helium-services-page-off.patch` | removes `routes.HELIUM_SERVICES` |
| Helium's web push server | An autopush WebSocket for site push messages | `engine/patches/chromium-helium-web-push-off.patch` | `ShouldAccessPushService`, `wss://services-disabled.qjz9zk/` |
| Helium's bang list in Chromium | `BangManager` fetching bangs | `engine/patches/chromium-helium-bangs-off.patch` | `std::vector<Bang>()` |
| Helium's translation providers | Page text sent to a translation provider | `engine/patches/chromium-helium-translate-providers-off.patch` | `HasTranslationProvider`, `return false;` |
| Helium's search engine assets | Non-free search engine icons fetched at build time | `engine/patches/chromium-helium-search-assets-off.patch` | `enable_builtin_search_provider_assets = is_internal_chrome_branded` |
| Helium's crash upload prompt (`crash.helium.computer`) | An infobar asking to upload crashes | `engine/patches/build/03-helium.py` | `crash-dialog.patch` |
| Helium's Sparkle updater in the engine | A second updater inside the framework | `engine/patches/build/03-helium.py` | `sparkle-glue.patch` |
| Component updater, everything but security components | Widevine, hints, models and other downloads | `engine/patches/chromium-component-updater-security-only.patch` | `kCrlSetId`, `kComponentDownloadHost` |
| Gemini in Chrome (Glic) and contextual cueing | Google's in-browser assistant | `engine/ardiacore/src/ardia/core/ac_main_delegate.cc` | `Glic,GlicActor` |
| Proxy and remote debugging switches | Command-line routes around the system proxy and into the profile | `engine/ardiacore/src/ardia/core/ac_main_delegate.cc` | `proxy-server` |
