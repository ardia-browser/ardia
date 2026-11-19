# The control socket

The `ardia` command (github.com/ardia-browser/plugins, `plugins/cli`) drives Ardia through one Unix socket,
`<data dir>/ArdiaControl.sock`: newline-delimited JSON, one request per line (`{"id", "method", "params"}`), one reply
per request (`{"id", "result"}` or `{"id", "error": {"code", "message"}}`), and events on subscribed connections
(`{"event", "time", "data"}`). The socket exists only while **Let the ardia command control Ardia** (`cliControl`) is
on; with it off every request answers `failed` "Control is off." (`state/automation/controlSocket.ts`). The contract
with the command (protocol numbers, `hello`) is in `docs/cli.md` › The contract.

This page is the map of the whole profile against the socket: every data point Ardia keeps, where it lives, and which
methods read and change it. The goal is full control: anything a person can see or change in Ardia, the command can
read and change, through the same store actions the UI calls, so every invariant, sync write, undo, saved document and
UI update still happens.

## Rules every method follows

- **Self-describing.** `methods` returns every method: `name`, `area`, `mutates`, a one-line `description`, `params` (a
  JSON Schema subset: `type`, `properties`, `required`, `enum`, `items`, `minimum`, `maximum`, `minItems`, `maxItems`,
  `additionalProperties: false`, `description`) and `result` (a short shape). The socket checks params against that
  schema before any handler runs, the core and plugin methods included (`socketSchema.ts`, `socketCatalog.ts`), so the
  catalogue can't drift from what it accepts. Only own properties count (a `constructor` or `__proto__` key is an
  unknown param, never a match from `Object.prototype`), and numbers must be finite (`1e999` parses to Infinity and is
  refused). A handler only sees the params its schema lists: reading, `in`-testing, `Object.hasOwn`-checking or describing any
  other key fails the call with `failed`, at the top level and inside nested closed objects (`subscribe`'s `idle`);
  values the schema leaves open (`apply`'s `ops`, `settings.set`'s `values`, `plugins.call`'s `input`) are the
  handler's to check. A test registers every handler the app registers (the core, area and plugin ones) and calls every
  method through it, so none reads an unlisted key and none is left without a handler. `ardia methods` prints it and `ardia call <method> [params]` calls any
  of them.
- **Control off means no more writes.** Consent is checked when a request arrives and again before every write that
  follows an `await` in a handler (a lookup, a confirmation, a settings read): handlers get a `SocketCall` and call
  `stillServing()` first, as `apply` does between ops. Turning control off mid-call answers `failed` "Control was
  turned off before Ardia made the change, so nothing changed." The check also runs inside the shared actions the
  socket calls, through a `may…` callback they take: after `profiles.delete`'s and `extensions.uninstall`'s
  confirmations; in `windows.close` before the "Don't ask again" and quit-warning preference writes and before the close starts (once the
  window's native close has started, AppKit has already ordered the window out, so the store close always finishes,
  whatever happens to control meanwhile; turning control off closes the connection, so the client then sees the stream
  end rather than a reply and has to treat the outcome as unknown); in Little Ardia's close after its quit prompt; in `tabs.reload`,
  `tabs.back` and `tabs.forward` after a shared page is handed over, and in cross-engine back after its unsaved-work
  check; in `downloads.open` before it reveals an opened archive; in `history.clear` before the cache write (the engine
  clear already ran, and the cache reconciles from the engine's own events); in `offscreen` after its ownership read;
  and in `plugins.remove` after the plugin is saved as off and again after its programs are unlinked, before its files go. A write that already happened is
  reported as done, never as "nothing changed". `apply` checks between ops and after each engine call inside `tab.sleep` and
  `tab.wake`. Each such call has 10 s; past that its op fails with `failed` and "outcome unknown", the batch queue moves
  on, and the tab stays busy (any op naming it is `refused` as busy) until the engine answers. The next `apply` reports
  that answer once under `late` (`{tabId: outcome}`). An op's `changed.tabs` lists only tabs it actually changed
  (`asleep`, `awake`), never ones it left alone (`shown`, `already`). When control goes off, every confirmation a socket call is waiting on is taken away (its sheet ends as a cancel, `DialogsModule.swift`
  `dismissShownOnly`), its call answers `refused`, and the per-window close guard is released, so a later close asks
  again. Left as they are: `run` checks once, as a menu command's own async work belongs to the UI it runs (a command
  that would ask or open a picker is refused up front in a background instance, see below); and an `answer` to a decide hook is checked when it arrives, and Ardia acts on it at
  once.
- **The UI's path, not a shortcut.** Where the UI does more than one store call, the socket does the same:
  `windows.close` goes through the window close guard (it asks first when the user set **Ask before closing a window
  with multiple tabs**, answers `refused` if they cancel, and keeps the last window to reopen). It shares the UI's
  one-close-per-window guard (a second close of a window that is already asking or closing answers `refused`), and
  decides whether a window is the last one at the moment its close commits, counting windows still animating closed as
  present, so two closes at once keep exactly one window to reopen. A close that is cancelled or refused (a tab arrived
  during the animation) drops any last-window marker while a regular window is open, so the marker only ever sits on
  the true last regular window. Every confirmation the socket can cause (`windows.close`, `profiles.delete`, `extensions.uninstall`, `tabs.back`
  across page engines) is asked with `confirm({onlyIfShown})` (`socketAsk.ts`, `DialogsModule.swift`): when Ardia would
  have to ask and nobody could see the question (no window of it is visible, or Ardia runs as a background instance), it
  answers `refused` instead of waiting on a dialog nobody can answer, and it never falls back to an app-modal alert. The
  reply comes only after the user answers. `run` keeps its contract (the reply comes at dispatch, and a prompt the
  command shows belongs to the UI it runs), so in a background instance it refuses, before running, the commands that
  would ask (`closeTab` on a window's last tab with its warning on, `closeTabGroup` with its warning on or on a shared
  folder, `back` across page engines) and those that open a picker nobody could use (`openFile`, `exportBookmarks`,
  `savePage`, `printWithSystemDialog`, `share` without `via:`). The guard resolves its target with the dispatcher's own
  `commandTarget` (`state/commands/commandTarget.ts`), so a Peek, a Little Ardia window and the main window it hands
  off to are judged exactly as `runCommand` will act (`runAsks.ts`). Linux and Windows
  ignore `onlyIfShown` for now and ask as before. `littleArdia.close` and `windows.close` on a Little Ardia reply
  only once the window is closed, so a Cancel on its quit prompt answers `refused`, `profiles.update
  {syncTabs: false}` retires the open-tab records as the Settings switch does (`setOpenTabsSynced`), `settings.set
  {tabLayout}` and `settings.reset {keys: ["tabLayout"]}` move open windows as Settings does (`chooseTabLayout`), even
  when the stored value already matches (windows that override it move back), and `settings.reset {keys: ["shortcuts"]}`
  drops every custom shortcut (where `settings.set {shortcuts}` adds to them, as `config.json` does).
- **Store actions only.** Writes call the domain's own actions (`storeAction(…)` on `useBrowser`, or the domain's
  exported functions for the stores outside it). Nothing calls `setState` on another domain's store.
- **Irreversible data loss asks the user.** `profiles.delete` and `extensions.uninstall` call the same actions the UI
  does, which show Ardia's confirmation on the last focused window; the reply waits for the answer (`{deleted}` /
  `{removed}`), and is `refused` when nobody can see the question.
- **Private stays private.** Private windows, incognito profiles and Peek's own tabs are invisible and untouchable, as
  in `windows` and `workspace` (`eligibleKind`, `isEligibleTab`).
- **Ids, not indexes.** Tabs, windows, groups, splits, bookmarks, downloads and profiles are named by the app's ids
  (`tabId`, `windowId`, `profileId`, …); `profile` may be omitted where the default profile (or the window's) is meant.
- **Errors** come from `automationMethods.ts`: `bad_request` (params don't match the schema, or a value is wrong),
  `unknown_method`, `no_window` (no such window, tab, profile, group, split, bookmark or download the command may use),
  `refused` (Ardia won't do that, with the reason), `failed` (it tried and it didn't happen), `stale` (an id from an
  earlier read no longer names what it named then; read again). A new code needs a new protocol number unless only
  methods new in the same release answer it: `stale` comes only from `history.remove`, which is new here, so the
  protocol stays 4. A request `id` is a safe integer or a well-formed string (no lone surrogate) of at most 256 UTF-8
  bytes; anything else is refused up front with `bad_request` and `"id": null` (`automationMethods.ts`). The native
  fallback in `ControlOutput.swift` echoes exactly the ids JS accepts and `null` for the rest (`true`, `1.5`, `2^53`,
  a lone surrogate), so no reply can overflow a line because of its id.
- **Big lists page, and the bound comes first.** `history.search`, `bookmarks.search`, `downloads.list` and `live.items` take `limit`
  (default 100, at most 1000) and `offset`, and answer `{ items, total, nextOffset }`; only the page is built. A page
  also stops once it reaches 512 KiB, with `nextOffset` where it stopped, and a string field over 32,768 characters is
  cut there and named in the row's `clipped` list, so any page fits on one line. A clipped value is never a key:
  `history.search` rows carry an `id`, a token holding a 64-bit hash of the full URL and that row's last visit
  (`h1.<hash>.<lastVisit>`, `historyKeys.ts`; the engine exposes no row id). It means the same thing cold or warm and
  across restarts. `history.remove` takes `ids`, or `urls` only when every URL is shorter than 32,768 characters (a
  longer one may be a clipped row whose text equals another page's URL, so it's refused with `bad_request`). An id
  whose page is gone, or was visited again since the search (including deleted and visited again), answers `stale`
  and nothing is deleted.
  `bookmarks.tree` stops at 5,000 items or about 1 MiB, leaves the folders it didn't open as a child count and says
  `truncated: true`; ask for a `folder` or a lower `depth` to see more.
- **History reads the newest 20,000 pages, cold or warm.** `history.search` works on one window: the newest 20,000
  pages by last visit, read from the engine, or from the app's history cache when that has loaded, with the same
  answer either way: both count only http, https and file pages, as the cache keeps. The engine read asks for more rows when other
  schemes fill its page, reading on past the cache's 100,000 rows (a warm cache that stopped there hands the read to
  the engine) up to 1,000,000 raw rows; only past that does it stop, with `truncated: true` and `total: null`. The
  engine's query has no offset, so nothing past those 1,000,000 raw rows can be paged to until the engine takes a
  starting point (an `engine/` change). Without a query or time range it reads only `offset + limit + 1` pages; with one it reads the
  window and filters it. `truncated: true` means history goes past the window (pages older than the newest 20,000
  aren't searched or paged to: an `offset` past it returns no items). `total` is exact only when Ardia read all of
  history: `null` when it read just enough for this page and one more, or when the window was cut off. `nextOffset`
  is `null` at the end of the results or of the window. The engine's query takes a page cap but still loads every
  visit before applying it (`ac_history.cc`); pushing the cap into the query is an `engine/` change, due with the next
  engine build.
- **The 1 MiB line.** Every line Ardia writes on the socket is at most 1 MiB (1,048,576 bytes), measured as sent: the
  escaped JSON, its envelope and the newline. That is the limit every shipped command reads (`MAX_LINE` in the
  command's `control.py` and `control.rs`; a longer line drops the connection) (`socketWire.ts`):
  - a read whose reply wouldn't fit answers `failed` "The reply would be over 1 MiB, the most a line can carry; ask for
    less (a smaller limit, a later offset, a folder, a window or a lower depth)";
  - a write (`mutates: true`) whose result wouldn't fit answers `{ok, oversized: true, …}` with its scalar fields and
    each list as `{count}`, and a hint to read it back, so the size never hides whether the write happened. A partial
    `apply` keeps `ok: false`, `applied` and its `error`'s `index`, `code` and `message` (cut to 1,024 characters) and
    `changed` (as counts if the ids don't fit);
  - an event keeps 64 bytes free for the `dropped` marker; one that wouldn't fit goes out with its scalar fields, each
    list as `{count}` and `truncated: true`;
  - a decide request that wouldn't fit isn't sent: Ardia goes on as if nobody answered (its default);
  - an error message is cut to 4 KiB.
- **The native queue** (`ControlOutput.swift`, `ControlConnection.swift`) holds three kinds of line per connection:
  - replies, and decide messages (requests and cancels, any line starting `{"decide":`): never dropped;
  - events: evicted oldest first when a reader falls behind (past 4 MiB or 1,000 waiting events, or to make room for a
    reply or decide message). The next event written starts with `"dropped": <n>`. If adding the marker would push
    that event over 1 MiB, it goes out unmarked and the count moves to the next event.
  - Everything waiting shares 34 MiB (32 pending requests of 1 MiB each, and room), less 64 bytes kept for the marker,
    which no reply uses.
  - The queue checks the line limit again: an event over 1 MiB is dropped and counted, and a reply over it is replaced
    with a `failed` error for the same id.
  - A connection is closed only when its own unread replies and decide messages fill the 34 MiB, it sends more than 32
    requests without reading, a request line passes 1 MiB or stalls for 30 s, or control is turned off. Ardia doesn't
    close it in the middle of a line by choice: it drops what was queued after that line (the replies are reported
    unwritten), stops reading, finishes the line within 5 s and then closes. A peer that reads nothing for those 5 s
    can see a cut line before the end of the stream; every shipped command reads an end of stream in the middle of a
    line as a dropped connection whose outcome is unknown, which is what it is. A write error closes at once.
  - A peer that closes only its writing side (it sent its requests and waits) gets only its replies: Ardia stops
    reading, drops the events and decide messages still queued (finishing a line already started), sends no new ones,
    and writes the replies queued and those still being worked out until all are written or 5 s pass, then closes.
  - A retiring connection keeps its descriptor and buffers for up to 5 s but no longer counts against the 16
    connections the socket admits, so at most 16 retire at once: a 17th closes the oldest retiring one at once.
  - `cli_socket_lines_shrunk` counts replies, events and decide requests that went out shortened.
  - Linux has its own queue in `engine/ardiacore-linux` and doesn't have these rules yet; that's an engine change.
- **Telemetry.** Each call counts once in its method family (`cli_socket_calls_<family>`) and once in
  `cli_socket_call_failures` when it answers an error: counts only, never which method's params
  (`state/telemetry/cliCounts.ts`).
- **Protocol.** Adding methods doesn't change the protocol: an older command never calls them, a newer command finds
  them in `methods` and gets `unknown_method` from an older Ardia. The protocol stays 4.

## Inventory

`useBrowser` is the workspace store (`state/browser/store.ts`), saved in `session.json`. ✅ means the socket reads and
changes it today, 🔍 read only, 🗺️ designed below, ⛔ deliberately not exposed.

| Area | What it holds | Where it persists | Socket |
| --- | --- | --- | --- |
| Windows | kind, profile shown, frame, maximized, full screen, tab layout, auto-hide, sidebar, focus order | `session.json` (`windows`, `windowOrder`), `launch-layout.json` | ✅ `windows`, `windows.*`; 🗺️ frame, maximize, full screen |
| Tabs | url, title, custom title and icon, pin, muted, zoom, page state, opener, created, last active | `session.json` (`tabs`), Chrome's tab restore | ✅ `apply` ops, `tabs.*` |
| Groups and folders | name, icon, colour, collapsed, pinned, nesting, members | `session.json` (`groups`), sync (`groupLooks`) | ✅ `apply` `group.*`, `workspace` |
| Pinned (Top Apps tiles, pinned rows, tile folders) | pin kind, pinned URL, tile folders, Top Apps sharing | `session.json` (`pinChoices`, `pinSync`, `parkedPins`), sync | ✅ `apply` `tab.pin`/`tab.unpin`, `tabs.setPinnedUrl`, `tabs.returnToPinnedUrl`, `pins.*` (tile folders) |
| Spaces (profiles) | name, colour, icon, theme, shared data, Top Apps sharing, open-tab sync, order, default | `session.json` (`profiles`, `profileOrder`, `settings.defaultProfileId`), Chrome profile dirs | ✅ `profiles.*` |
| Splits | panes, orientation, sizes, stacks | `session.json` (`splits`) | ✅ `splits.*` |
| Peek | the page peeked from each tab | memory | ✅ `peek.*` |
| Little Ardia | small windows and their profile | `session.json` (`windows` of kind `small`) | ✅ `littleArdia.*` |
| Recently closed | closed tabs, windows, groups, deleted groups, cleaned-up tabs | `session.json` | ✅ `closed.*` |
| Bookmarks | folders, links, bar order, favicons | Chrome's Bookmarks file per profile (`bookmarks-cache.json` mirror) | ✅ `bookmarks.*` |
| History | url, title, visits, last visit, visit times | Chrome's History database per profile | ✅ `history.*` |
| Downloads | file, path, state, progress, profile, dangerous | Chrome's History database, `downloads.json` | ✅ `downloads.*` |
| Download settings | folder, ask where to save | Chrome prefs | ✅ `downloads.settings`, `downloads.setSettings` |
| Settings | the 109 keys of `SETTING_SPECS` (every switch and choice in Settings) | `session.json` (`settings`, `settingsMeta`), sync for the synced ones, `config.json` (read only) | ✅ `settings.*` |
| Search engines | default, custom engines, extension engines | `settings` | ✅ `search.*` |
| Site settings and permissions | per-origin content settings (camera, location, notifications, popups, JavaScript, sound, …), zoom per host, preload | Chrome prefs per profile | ✅ `sites.*` |
| Extensions | installed, enabled, pinned, toolbar order, options | Chrome's extension prefs, `sync-extensions.json` | ✅ `extensions.list`, `extensions.setEnabled`, `extensions.setPinned`, `extensions.reload`, `extensions.uninstall` |
| Plugins | installed, enabled, consent, tools | `plugins.json`, `Plugins/` | ✅ `plugins`, `plugins.*` (`state/plugins/socketMethods.ts`) |
| Media sessions | now playing per tab, PiP, shares | memory (`state/media/media.ts`) | ✅ `media.list`, `media.control` |
| Sync | folder, devices, synced types and profiles, remote tabs | `sync.json`, sealed `sync-*.nns` | 🔍 `sync.status` |
| Saved passwords | origin, username, password | Chrome's Login Data (keychain-sealed) | 🔍 `passwords.list` (no passwords); ⛔ reveal, see Secrets |
| Autofill | addresses, cards | Chrome's Web Data | 🔍 `autofill.list` (no card numbers); ⛔ card numbers |
| Cookies and site data | cookies, storage per origin | Chrome's Cookies and storage | ✅ `sites.clearData`; ⛔ cookie values |
| Favicons | icon per page | Chrome's Favicons database, app cache | 🔍 `favicons.get` |
| Shared folders | groups backed by a folder, their identities | `shared-folders.json`, `.ardia-folder.json` | ✅ `sharedFolders.*` |
| Live folders | pull request and document folders, their items, hidden and read state, connected accounts | `live.json` | ✅ `live.*`; ⛔ account tokens |
| Sidebar layout | width, side, pinned collapsed, auto-hide | `settings` (`sidebarWidth`, `sidebarSide`, `autoHideTabs`), profiles (`pinnedCollapsed`) | ✅ through `settings.set`, `profiles.update`, `windows.setLayout` |
| Presets and themes | setup codes, profile looks, theme files | `settings`, `themes/*.json`, profiles (`theme`) | ✅ `profiles.setLook`, `presets.apply`, `presets.describe` |
| Omnibox | providers, bangs state, approvals | `settings.omniboxProviders`, `bangs-state.json`, `automation-approvals.json` | ✅ providers through `settings.set`; 🗺️ bangs |
| Session and restore | the whole workspace | `session.json` | ✅ through the areas above; ⛔ the raw document |
| Reader | text size, font | `settings` (`readerTextSize`, `readerFont`) | ✅ `settings.set` |
| Air traffic (link routing rules) | rules per source app, Everything Else | `air-traffic.json` | ✅ `airTraffic.*` |
| Hooks, config, approvals | hook rules, config.json, approvals | `hooks.json`, `config.json`, `automation-approvals.json` | files the user edits; ⛔ approvals |
| Telemetry, reports, onboarding, release notes | the app's own bookkeeping | their documents | ⛔ not profile data |

## Methods

`mutates` is what `methods` reports. Every method also takes nothing it doesn't list (`additionalProperties: false`).

### Already there (protocol 4)

| Method | Mutates | What it does |
| --- | --- | --- |
| `hello` | no | Protocol handshake: `{ app, version, protocol, minClientProtocol }` |
| `caller` | no | Notes the caller the command named in `hello` |
| `methods` | no | This catalogue |
| `commands` | no | The command catalogue `run` takes |
| `windows` | no | Windows and their tabs, with each tab's DevTools target |
| `workspace` | no | The sidebar tree of a window or profile: pinned, groups, tabs, with usage on request |
| `apply` | yes | A batch of ops on tabs, groups and pins (`docs/automation.md`): `open`, `tab.*`, `group.*` |
| `run` | yes | Runs a menu command in a window or on a tab |
| `offscreen` | yes | Moves a tab the command opened off-screen |
| `subscribe` | yes | Events and decide hooks this connection serves: `{events, fullUrls?, idle?, hooks?}` |
| `answer` | yes | Answers a decide hook: `{decide, answer?}`; Ardia acts on the answer |
| `plugins`, `plugins.official`, `plugins.enable`, `plugins.disable`, `plugins.remove`, `plugins.call` | mixed | Plugins |

### Added here

| Area | Read | Write |
| --- | --- | --- |
| tabs | `tabs.list {window?, profile?}`, `tabs.get {tab}` | `tabs.navigate {tab, url}`, `tabs.reload`, `tabs.back`, `tabs.forward`, `tabs.duplicate`, `tabs.setPinnedUrl {tab, url?}`, `tabs.returnToPinnedUrl` |
| windows | `windows.get {window}` | `windows.create {profile?, url?, layout?}`, `windows.close`, `windows.focus`, `windows.setLayout {window, layout?, tabsShown?}`, `windows.switchProfile`, `windows.merge` |
| closed | `closed.list {window?}` | `closed.restore {id, window?}`, `closed.clear {window?}` → `{cleared}`; both act on the window's profile, the last focused main window when `window` is left out, and answer `no_window` when there's none |
| profiles | `profiles.list` | `profiles.create`, `profiles.update`, `profiles.setLook`, `profiles.reorder`, `profiles.setDefault`, `profiles.delete {profile}` (Ardia asks the user first) |
| splits | `splits.list {window?}` | `splits.create {tabs, orientation?}`, `splits.separate`, `splits.removeTab`, `splits.resize {split, sizes}`, `splits.flip`, `splits.setOrientation` |
| peek | `peek.list` | `peek.open {tab, url}`, `peek.close {tab}`, `peek.toTab {window}` |
| littleArdia | (in `windows`) | `littleArdia.open {url?, profile?}`, `littleArdia.close`, `littleArdia.toMain` |
| bookmarks | `bookmarks.tree {profile?, folder?, depth?}`, `bookmarks.search {profile?, query, limit?, offset?}`, `bookmarks.get {id}` | `bookmarks.add`, `bookmarks.addFolder`, `bookmarks.update`, `bookmarks.move {ids, parent, index?}`, `bookmarks.remove {ids}` |
| history | `history.search {profile?, query?, since?, until?, limit?, offset?}` (rows `{id, url, title, visits, lastVisit, clipped?}`) | `history.remove {profile?, ids \| urls}`, `history.clear {profile?, since?}` |
| downloads | `downloads.list {profile?, state?, limit?, offset?}` (live progress for running downloads), `downloads.settings {profile?}` | `downloads.pause`, `downloads.resume`, `downloads.cancel`, `downloads.keep`, `downloads.open`, `downloads.reveal`, `downloads.remove`, `downloads.clear`, `downloads.setSettings` |
| settings | `settings.get {keys?}`, `settings.schema` | `settings.set {values}`, `settings.reset {keys}` |
| search | `search.engines` (`default` is the engine searches use, an extension's when one controls it, with `controlledBy`) | `search.setDefault {id}` (`refused` while an extension controls it, as Settings disables the picker; so is `settings.set {searchEngine}`), `search.add`, `search.update`, `search.remove` |
| sites | `sites.origins {profile?}`, `sites.get {origin, profile?}`, `sites.zoomLevels {profile?}` | `sites.set {origin, type, value}`, `sites.reset {origin}`, `sites.setZoom {host, zoom}`, `sites.clearData {site}` |
| extensions | `extensions.list {profile?}` | `extensions.setEnabled {id, enabled}`, `extensions.setPinned`, `extensions.reload`, `extensions.uninstall` (Ardia asks the user first) |
| media | `media.list` | `media.control {tab, action, seconds?}` |
| sync | `sync.status` | none yet |
| passwords, autofill | `passwords.list {profile?}`, `autofill.list {profile?}` | `passwords.remove {origin, username}` |
| pins (tile folders) | `pins.folders {window?}` | `pins.createFolder {tabs, name?}`, `pins.renameFolder {folder, name}`, `pins.removeFolder {folder}`, `pins.addToFolder {folder, tabs}`, `pins.removeFromFolder {tabs}` |
| favicons | `favicons.get {url, profile?}` | none |
| sharedFolders | `sharedFolders.list` | `sharedFolders.share {group, parent?}`, `sharedFolders.add {path, window?}`, `sharedFolders.sync {group}`, `sharedFolders.stop {group}` |
| live | `live.list {profile?}`, `live.items {folder, limit?, offset?}` | `live.create {kind, profile?, sources?, name?}`, `live.update`, `live.remove`, `live.refresh`, `live.hide {folder, items}`, `live.unhide`, `live.markRead {folder, items?}`, `live.setRepoHidden {folder, repo, hidden}`, `live.open {folder, item, window?}` |
| presets | `presets.describe {code}` | `presets.apply {code, window?}` |
| airTraffic | `airTraffic.rules`, `airTraffic.test {url, from?}` | `airTraffic.addRule`, `airTraffic.updateRule {id, …}`, `airTraffic.removeRule {id}`, `airTraffic.moveRule {id, index}`, `airTraffic.setFallback {open, profile?, group?}` |

`settings.set` takes the same keys and values `config.json` does (`state/settings/configAllowlist.ts`, checked by
`checkedSettings`), applied with `updateSettings`, so a value the Settings UI can choose is a value the command can set.
The keys `config.json` can't set stay off `settings.set` and have their own methods where it makes sense:
`defaultProfileId` is `profiles.setDefault`, `customSearchEngines` is `search.*`. `cliControl` stays refused (the
command can't switch control itself on or off), and so does `allowJavaScriptFromAppleEvents` (it would let any
AppleScript run script in every page). `pageEngine`, `websiteEngines`, `protectedVideoInWebKit`, `newTabUrl`,
`customSearchUrl` and `extensionSearchEngines` are refused in this first round, as `run` refuses `changesEngine`; they are
listed under Next.

### Tile folders, icons, shared and live folders, presets, Air Traffic

Each area is its own file: `socketPins.ts`, `socketFavicons.ts`, `socketSharedFolders.ts`, `socketLive.ts`,
`socketPresets.ts`, `socketAirTraffic.ts`, and counts in its own family (`pins`, `favicons`, `shared_folders`, `live`,
`presets`, `air_traffic`). A method that awaits gets the request's control generation (`SocketCall` in
`socketCatalog.ts`) and checks it before each change that follows an await, so switching control off stops it there.

- **Tile folders** (`state/pins/tileFolders.ts`, the same transforms the sidebar's drag and Rename/Remove Folder menu
  apply). A folder lives in one window's Top Apps for the profile the window shows, so `pins.folders` takes a window;
  `pins.createFolder` pins its tabs as tiles, and every tab must be in one main window and its profile. Removing a
  folder, or a tab from it, leaves the tabs pinned as tiles, as the menu does; a folder left with one tab dissolves.
  `createFolder` and `addToFolder` refuse a split's pane (its panes pin together as rows, so the sidebar's folder drop
  leaves them out) and the last tab of a shared sidebar folder, with apply's own checks, before anything changes.
- **Favicons.** `favicons.get` answers from the app's icon cache (`resolveFavicon`) and otherwise from the profile's
  icon database (`faviconsFor`), with `{found, mime, data}` (base64). It never fetches from the network, so reading
  icons can't tell a site the page is open.
- **Shared folders** (`state/sharedFolders`). `share` makes the folder in iCloud Drive's Ardia folder (or `parent`
  when iCloud Drive is off) and syncs it once; instead of the macOS share sheet, the reply carries the folder's path and
  file URL for the command to share. `add` binds a folder someone shared as a new pinned folder, as Add Shared Folder
  does without its folder picker. `stop` is Stop Syncing: the group and the files stay. It cancels the batch being
  written, if any, and answers only once that batch has finished; when it can't confirm that within 10 seconds it
  answers `failed`, with the binding already gone.
  Paths are resolved once to the real folder (`resolve` in `SharedFoldersModule.swift`): the binding stores that path and
  the folder's device and inode. The native layer (`SharedFolderDirectory.swift`) opens the root once with `O_NOFOLLOW`,
  checks its device and inode, and does every scan, read, write, rename, mkdir and unlink relative to folder descriptors
  it holds while descending (`openat`, `fstatat`, `renameatx_np`, `unlinkat`), so a root or subfolder swapped after the
  check is never followed, and two spellings of one folder are one binding. `/`, system folders and home folders are
  refused by device and inode as well as by path, so `/System/Volumes/Data/Users` and the home folder's data-volume path are refused too (`resolve` rejects with `ERR_SHARED_FOLDER_REFUSED`, answered as `refused`); `parent` must already exist and is
  held by descriptor and checked against its identity through creation, never recreated. `create` returns the new
  folder's identity in the same call, and a folder `share` made but couldn't use is removed only while it is still that
  empty folder. A binding made before identities existed (from the sidebar, or an older Ardia) is never filled in from
  whatever is at its old path now: it shows "Pick the folder again to keep syncing" (`state: "reconnect"`), reads and
  writes nothing, and the sidebar's Reconnect Folder… asks the person to pick it; the reconnected binding starts from
  a fresh merge base. `add` with the old path finds that binding instead of making another. A folder syncs with one
  profile at a time: `add` in another profile answers `refused`, naming the group that has it. Binding is compare-and-set for the sidebar and the
  socket alike: whichever finishes making a folder second keeps the first one's binding and removes its own. `add` reads
  the folder before saving anything, so a missing, unreadable or too big folder (over 20,000 items or 32 MB of links and
  order files, counted while listing) answers an error and adds nothing. Requests for one group run one at a time;
  `share` re-checks the group after making the folder and removes the folder it made when the group changed or control
  went off. A sync started by the socket stops before writing once control is off, its retries keep that check, and a
  write already under way when control goes off commits nothing. When the first sync fails, `share` answers `failed`
  with the reason instead of the URL, as the sidebar shows a toast instead of the share sheet; the binding stays, as it
  does there.
  The native `read` and `apply` refuse a missing identity rather than open a path.
  Folder names drop control characters (NUL included), `/` and `:`, and `create` tries at most 1,000 numbered names.
  `create` compares the identity it `fstatat`s right after `mkdirat` with the folder it then opens. A rename checks the
  source's identity just before `renameatx_np` with `RENAME_EXCL` and moves it back if what landed isn't that file; a
  folder is removed by renaming it to a unique hidden name, checking its identity there, and only then removing it (a
  replacement is renamed back). `rmdir` checks the folder's identity before it touches the order file or any other
  housekeeping file in it, and puts them back if it can't remove the folder. Replacing a link swaps the new file in
  with `renameatx_np(RENAME_SWAP)` after checking the old one's identity, then checks that what it swapped out is that
  file and swaps back if not; deleting a link renames it to a hidden name, checks its identity and URL there, and only
  then unlinks it. What remains is the moment between the last check and the rename or swap, and a rename back that
  fails because the name was taken in between, which leaves the other file under the hidden name; nothing is ever
  removed in that case. `mkdir` and `rmdir` check that the parent's path still names the held folder, and `mkdir` onto
  a folder that already exists is a conflict, so a name another device made (in another Unicode form, say) is merged
  on the next read instead of written into. The planner reserves names the way APFS compares them (Unicode
  normalization and case together). File coordination and iCloud download requests stay path-based, because
  `NSFileCoordinator` and iCloud work by path; each coordinated read, write and delete first checks that the path
  still names the held folder, and a folder whose path moved is a conflict or an error, never a write elsewhere. Staged
  files land with `renameatx_np` into the held descriptor. iCloud download requests (`startDownloadingUbiquitousItem`)
  stay path-based outside the checked callbacks: at worst they ask iCloud to download a file in the folder now at that
  path, and nothing is read or written there. Every byte read while scanning counts toward the 32 MB cap, whether or
  not it decodes, and so does a binary link's size once converted to XML (over 64 KB, it's held as unreadable). A scan
  stops after 30 seconds, and a file that doesn't answer its coordination in time is an error for that read, not a
  missing link. Each folder has its own native queue, so a slow folder never holds up the others. A socket round's
  write batch carries a cancel token: the engine cancels it as soon as the round's control check fails or the binding
  changes, and native `apply` checks it before each change and again after each file-coordination wait, then stops
  with `cancelled`, committing nothing. Add, from the sidebar or the socket, runs one at a time per folder identity and binds only
  when no binding in the profile has that identity. `add` checks control after every await before it changes anything.
  A sidebar change made by a socket round (remote links applied) is tagged with that round's guard. A follow-up the
  store starts runs under that guard, and any later round, from the store, the folder watcher or the minute poll,
  writes nothing for a tagged change whose guard was revoked: the disk side wins, and the round only records the
  folder as it is on disk.
  A group bound to a shared folder syncs to disk whenever it changes, so the socket leaves it alone: `apply` answers
  `refused` ("shared folder groups change only from the sidebar") for any op that would change such a group's members,
  their order, a tab or group title inside it, or its nesting, including moving a tab or group into or out of it,
  opening a tab into it, placing one beside a member, closing, pinning or unpinning a member, and renaming, moving,
  ungrouping, closing or deleting the group or a group inside it (`workspaceSharedGuard.ts`, checked before each op
  runs). Muting, sleeping or activating a member and changing the group's colour, icon or collapsed state still work.
  `pins.createFolder` and `pins.addToFolder` refuse a member for the same reason, and `airTraffic.addRule` and
  `updateRule` refuse a `group` that is a shared folder.
- **Live folders** (`state/live`). `create` refuses a source that isn't connected (connecting asks for tokens and a
  browser sign-in, so it stays in Settings › Automations); `remove` is Delete Live Folder and closes its tabs, as the
  menu does. Account tokens are never read. `create` checks the name and sources before saving anything, and with no
  `sources` takes the connected ones of its kind, refusing when none is. A refresh asked for while one runs with other
  sources or filters fetches again after it, and a pass whose sources or filters changed under it drops its results.
  A socket refresh joins only a pass started by the same request; otherwise it waits for the running pass and then
  fetches for itself, so a refresh after control went off and on never returns a revoked pass's old state. A pass checks
  control before it claims the refresh (the Linux document client's claim fences out other writers), before it fetches
  and before it commits, so a pass whose control was revoked claims and supersedes nothing, and the follow-up a settings change queues keeps the guard of the
  pass that queued it, so its results never land once control is off. `live.items` lists the folder's listed, then hidden, then recently completed items as
  `{item, shown, unread, completed}`, each item once (an item still animating out counts as completed), a page at a
  time, building rows only for the page. An item over 256 KiB of JSON is sent as `{id, source, oversized: true}`, so
  one huge item never turns its page into an error; open it with `live.open`.
- **Presets.** `presets.apply` is Settings › Apply a setup code (`applySetupCode`): the code's settings, and its colour
  and pinned apps on the given or focused main window's profile. `presets.describe` decodes a code without applying it.
- **Air Traffic Control** (`state/airTraffic/store.ts`). Rules are `{from, when, profile, open, group}`: `from` an app
  (`{name, bundleId?}`, any app when null), `when` a condition (`any`, `site` with `host`, `pattern`, `contains` or
  `equals` with `text`) checked as the Settings pane checks it, `profile` null for the profile used last, `group` a key
  from `airTraffic.rules` and only with `open: "tab"`. `moveRule` takes the new index and saves the new order in one
  write; `setFallback {open: null}`
  puts Everything Else back to Ardia's usual choice; `test` is the pane's link tester.

### Events

`subscribe` already sends tab, window, split, peek, pin, profile and settings events (`eventNames.ts`). Writes here
change the store, so those events fire for them as for a click. Next adds `bookmarks.changed`, `history.removed`,
`download.changed` and `profile.changed` (each one store watch in `storeEvents.ts`, no protocol change).

### Clearing site data is per site

`sites.clearData {site}` deletes cookies and stored data for a whole site: the registrable domain of the host given and
every subdomain, over http and https (`mail.example.com` clears all of `example.com`). That is what the engine's
`ac_site_data_clear` does (`ac_site_settings.cc`, `RegistrableDomainOf`) and what the page menu's Clear Site Data does.
The method took an `origin` before and silently cleared more than that origin; it now takes `site` and refuses
`origin`, so an older caller gets `bad_request` instead of a wider delete. Clearing a single origin needs an engine change
(an origin filter in place of the site filter), which can't ship in this app-only change; if it's wanted, it comes as
`sites.clearOriginData {origin}` with the next engine.

## Plugin sessions

Plugins must never reach these store methods: a plugin acts through the mediated browse verbs, each of which asks the
user or stays inside what the plugin was granted. Today the socket can't tell a plugin from the owner's `ardia`
command: both connect to the same socket as the same user, and a plugin flag a client sends is only its own claim.

**Design (not built):** when Ardia starts a plugin activity, it mints a random per-activity credential and hands it to
the plugin's CLI child on an inherited file descriptor (never an environment variable, a file, or
`ArdiaControl.json`, which every process of the user can read). The child sends it in `hello` as `session`; the socket
looks it up, marks the connection `plugin`, and drops the credential when the activity ends or the connection closes.
A connection without one is the owner's. A plugin connection may call `hello`, `methods` and the mediated browse verbs
as they land, and nothing else: no `apply`, `run`, `subscribe`, `answer`, `plugins.*`, and none of the store methods
above. The dispatcher already has its single check point for this: `controlSocket.ts` asks `connectionAccess` for each
request and `accessProblem` (`socketCatalog.ts`) refuses everything outside `PLUGIN_SESSION_METHODS` for a plugin
connection, before params are even checked. Until the credential exists every connection is `owner`.

## Secrets

**Chosen:** the socket lists saved logins (origin and username) and autofill entries (addresses, and cards by name,
network, last four and expiry), and removes a saved login, behind the same consent as every other method. It never
returns a password, a full card number or a cookie value.

**Why:** "every single data point" covers knowing what is saved and cleaning it up, and those reads carry nothing an
attacker could log in with. Revealing a password in Ardia's own UI asks macOS for the user's password or Touch ID
(`unlockPasswordsFor`); a socket method that did the same would put that system prompt on screen with no context of
which program asked, and anything that can reach the socket (every process of the user) could ask. Cookie values are
the user's live sessions on every site. Both are a different consent than "control Ardia".

**Next, if the owner wants it:** `passwords.reveal {origin, username}` behind its own switch in Settings › Advanced
(off by default) and the macOS re-auth on every call, with Ardia's own sheet naming the program first.

## Next

Designed, not built in this round, each in its own file under `state/automation/socket<Area>.ts`:

- **Window geometry:** `windows.setFrame {window, frame}`, `windows.setMaximized`, `windows.setFullScreen`. The store's
  `frame`, `maximized` and `fullScreen` follow the native window (`windows/windowSync.ts`), so these need a native
  call that moves the window (`ArdiaWindows`), which doesn't exist yet; `run` covers full screen through its command.

- **Sync:** `sync.now`, `sync.setType {type, on}`, `sync.setProfile {profile, on}`, `sync.sendTab {tab, device}`
  through `state/sync/engine.ts`.
- **Extensions:** `extensions.install {webStoreId}` (opens the install prompt the user confirms), `extensions.configure`.
- **Settings refused today:** `pageEngine` and `websiteEngines` once a socket write can move open pages between engines as
  the Settings pane does; `newTabUrl` and `customSearchUrl` with the URL checks `apply` uses.
- **Events:** `bookmarks.changed`, `history.removed`, `download.changed`, `profile.changed`.
