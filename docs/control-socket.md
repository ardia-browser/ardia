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
  turned off before Ardia made the change, so nothing changed." for a change it stopped before its first write; an
  `apply` batch keeps the ops it already ran (no rollback) and reports them in `results` and `applied`, so read those
  before retrying. The check also runs inside the shared actions the
  socket calls, through a `may…` callback they take: after `profiles.delete`'s and `extensions.uninstall`'s
  confirmations; in `windows.close` before the "Don't ask again" and quit-warning preference writes and before the close starts (once the
  window's native close has started, AppKit has already ordered the window out, so the store close always finishes,
  whatever happens to control meanwhile: a close started before control was revoked completes. Turning control off
  closes the connection, so the client sees the stream end rather than a reply and has to treat the outcome as
  unknown); in Little Ardia's close after its quit prompt; in `tabs.reload`,
  `tabs.back` and `tabs.forward` after a shared page is handed over, and in cross-engine back after its unsaved-work
  check; in `downloads.open` before it reveals an opened archive; in `history.clear` before the cache write (the engine
  clear already ran, and the cache reconciles from the engine's own events); in `offscreen` after its ownership read;
  and in `plugins.remove` after the plugin is saved as off and again after its programs are unlinked, before its files go. A write that already happened is
  reported as done, never as "nothing changed". `apply` checks between ops and after each engine call inside `tab.sleep` and
  `tab.wake`. Each such call has 10 s; past that its op fails with `failed` and "outcome unknown", the batch queue moves on,
  and the tab stays busy (any op naming it is `refused` as busy) until the engine answers, the tab closes, control goes
  off, or 60 s pass (then the outcome stays unknown). The answer belongs to the connection whose op timed out: its
  next `apply` reports it once under `late` (`{tabId: outcome}`); it's dropped if that connection closed, and an
  answer from before control went off is dropped too. An op's `changed.tabs` lists only tabs it actually changed
  (`asleep`, `awake` after a reload, `loading` when a sleeping tab's page was asked to load), never ones it left alone
  (`shown`, `already`, `no_view` when the tab's view is known to be gone, `reload_unverified` when it reloaded but
  the platform can't say whether the view is still attached). Whether a view is attached is awaited on every platform (`isAttached`, async on Windows and Linux); "can't tell" is
  never read as attached, and the request scope is checked again right before the reload, so a client that left
  during that await reloads nothing.
- **A request lives only while its connection and consent do.** Each request captures its connection and the consent generation when it starts (`SocketCall.serving`,
  `controlSocket.ts`). A connection counts as gone the moment its peer stops writing: at read EOF the native side tells
  JS at once (`onPeerFinished`, sent as the connection's close) while it goes on writing the replies already queued,
  so a search or `apply` still running on it is abandoned then, not when the drain ends. A client that leaves while a confirmation it caused is up takes that question away (by key, `dismissShownOnly`) and
  frees the window's close guard, as turning control off does. Ardia uses dismissal only where the platform's dialogs
  module says it can (`dismissesShownOnly: true`, native API 84 and later on macOS; Linux's bridge answers every
  method, so a callable is no proof), and the request lets go only once the dismissal succeeded: if it rejects, or
  the platform can't dismiss, the guard holds until the dialog is answered and is freed when it closes. After every await, a request whose connection
  closed or whose generation changed is abandoned without touching shared state: the writers of that state check the
  scope themselves, so a search that resumes after a disconnect creates no handle table (`historyHandle`), and an
  `apply` whose wait spans a disconnect or a control toggle registers no busy tab and stores no late result
  (`awaitLate`), and runs no further ops. Consent is checked again immediately before any confirmation opens, so a call that was still reading (say,
  `profiles.delete` listing extensions) when control went off opens nothing. When control goes off while a
  confirmation is open, on macOS it's taken away (its sheet ends as a cancel, `DialogsModule.swift`
  `dismissShownOnly`), the call ends `refused` internally and the per-window close guard is released, so a later close
  asks again. Where nothing can take a dialog away (Linux and Windows today) the guard holds until the dialog is
  answered, and a yes given after control went off changes nothing. A question taken away may end its call as `refused` or as `failed` ("nothing changed"), depending on whether the
  dismissal or a user's answer given at the same moment lands first. Either way the client doesn't see it: turning
  control off closes its connection, so it sees the stream end, and the outcome is unknown to it. A window close the
  user had already authorized before control went off still finishes its animation and commits. Left as they are: `run` checks once, as a menu command's own async work belongs to the UI it runs (a command
  that would ask or open a picker is refused up front in a background instance, see below); and an `answer` to a decide hook is checked when it arrives, and Ardia acts on it at
  once.
- **The UI's path, not a shortcut.** Where the UI does more than one store call, the socket does the same:
  `windows.close` goes through the window close guard (it asks first when the user set **Ask before closing a window
  with multiple tabs**, answers `refused` if they cancel, and keeps the last window to reopen). It shares the UI's
  one-close-per-window guard (a second close of a window that is already asking or closing answers `refused`), and
  decides whether a window is the last one at the moment its close commits, counting windows still animating closed as
  present, so two closes at once keep exactly one window to reopen. A close that is cancelled or refused (a tab arrived during the animation, or nobody could see the question) drops
  any last-window marker while a regular window is open, so the marker only ever sits on
  the true last regular window. Every confirmation the socket can cause (`windows.close`, `profiles.delete`, `extensions.uninstall`, `tabs.back`
  across page engines) is asked with `confirm({onlyIfShown})` (`socketAsk.ts`, `DialogsModule.swift`): when Ardia would
  have to ask and nobody could see the question (no window of it is visible, or Ardia runs as a background instance), it
  answers `refused` instead of waiting on a dialog nobody can answer, and it never falls back to an app-modal alert. The
  reply comes only after the user answers. `run` keeps its contract (the reply comes at dispatch, and a prompt the
  command shows belongs to the UI it runs), so a background instance runs no command at all: `run` answers `refused` "run isn't available in background
  instances; use the dedicated methods". Menu commands reach UI and page loads in too many ways (a lazy tab that
  starts loading when switching tabs activates it, a homepage, a closed tab's saved URL, any of which can raise
  Chromium's HTTP-auth dialog), so the dedicated methods are the background surface: `apply`, `tabs.*`, `windows.*`,
  `closed.restore` and the rest. Anything that calls `runMethod` gets the same answer there (a plugin's `run`,
  surface menus). `state/commands/commandInteraction.ts` still documents every command as `quiet`, `interactive` or
  `asksWhen`. A visible instance runs every command, since the person sees whatever opens. In a background instance
  `downloads.open` is refused too ("opening a download needs the person"), since it launches another app, and so is
  `downloads.reveal` ("revealing a download needs the person"): a background instance only logs a reveal, so it
  can't claim Finder showed the file. `runCommand` resolves its target in one place, `commandTarget` (`state/commands/commandTarget.ts`). Linux and Windows
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
  `refused` (Ardia won't do that, with the reason), `failed` (it tried and it didn't happen), `password_manager_plugin`
  (the profile's passwords are kept by a password-manager plugin, see Secrets). A new code needs a new protocol number
  unless only methods new in the same release answer it: `password_manager_plugin` comes only from `passwords.list` and
  `passwords.remove`, which are new here, so the protocol stays 4. A request `id` is a safe integer or a well-formed string (no lone surrogate) of at most 256 UTF-8
  bytes; anything else is refused up front with `bad_request` and `"id": null` (`automationMethods.ts`). The native
  fallback in `ControlOutput.swift` echoes exactly the ids JS accepts and `null` for the rest (`true`, `1.5`, `2^53`,
  a lone surrogate), so no reply can overflow a line because of its id.
- **Big lists page, and the bound comes first.** `history.search`, `bookmarks.search` and `downloads.list` take `limit`
  (default 100, at most 1000) and `offset`, and answer `{ items, total, nextOffset }`; only the page is built. A page
  also stops once it reaches 512 KiB, with `nextOffset` where it stopped, and a string field over 32,768 characters is
  cut there and named in the row's `clipped` list, so any page fits on one line. A clipped value is never a key:
  `history.search` rows carry an `id`: an opaque handle (20 random bytes from `crypto.getRandomValues`, or on Hermes,
  which has no Web Crypto, only the random bits of native UUID v4s; `platform/secureRandom.ts`) in a table
  kept for this connection
  (`historyHandles.ts`), mapping to the full URL and the profile and engine it was read from. The same page keeps its
  handle on that connection, cold or warm; the table goes when the connection closes or control goes off, and another
  connection's or an expired handle answers `bad_request` "unknown history id; search again". `history.remove`
  removes pages, as the browser's own Remove from History does: every visit to each exact URL, including visits made
  after the search (the engine has no row id and no check-and-delete, so "this exact visit" can't be promised without
  an `engine/` change). It takes `ids`, deleting from the profile and engine each was read from (refused with
  `bad_request` if that profile's history moved since), or `urls`, deleting from the profile resolved when the request
  arrived; it reads no history and awaits nothing, so the default profile changing meanwhile can't redirect it. A URL
  of 32,768 characters or more may be a clipped row whose text equals another page's URL, so it's refused as a key:
  a clipped row is deleted by its id.
  `bookmarks.tree` stops at 5,000 items or about 1 MiB, leaves the folders it didn't open as a child count and says
  `truncated: true`; ask for a `folder` or a lower `depth` to see more.
- **History reads the newest 20,000 pages, cold or warm.** `history.search` works on one window: the newest 20,000
  pages by last visit, read from the engine, or from the app's history cache when that has loaded, with the same
  answer either way: both count only http, https and file pages, as the cache keeps. A cold read first asks the engine for just the rows the page needs; when other schemes fill them it makes one more
  call for 200,001 raw rows and filters those (a warm cache that stopped at its 100,000 hands the read to the engine
  the same way). That bounds a request at two engine calls; the engine's query has no offset, so a further call would
  re-read from the newest page. If that call returns 200,001 rows and the page still isn't full, the answer says
  `truncated: true` with `reason: "scanLimit"` and `total: null`; 200,000 rows or fewer means history was read to its
  end, so the total is exact (counted before the page is cut, so 10 web pages and a `chrome://` row with `limit: 5`
  report `total: 10`); past the
  20,000-page window it says `reason: "window"`. A follow-up with `nextOffset` works inside both; nothing past the
  budget can be paged to until the engine query takes a starting point (an `engine/` change). Without a query or time range it reads only `offset + limit + 1` pages; with one it reads the
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
    reading, drops the events and decide messages still queued (finishing a line only if at least one byte of it was written:
    a head that met a full socket with nothing written is dropped too), sends no new ones,
    and writes the replies queued and those still being worked out until all are written or 5 s pass, then closes.
  - A retiring connection keeps its descriptor and the one line it's finishing (at most 1 MiB) for up to 5 s but
    no longer counts against the 16 connections the socket admits, so at most 16 retire at once: a 17th closes the
    oldest retiring one at once, which can cut that client's line even during normal serving (a peer retired for
    passing the request or queue limits while others are retiring). At worst the socket holds 16 live connections with 34 MiB of queued output each and 16 retiring ones with 1 MiB
    each, about 560 MiB. That counts queued bytes; the line being written also holds up to 64 KiB of what already went
    out (the queue releases the written prefix every 64 KiB), about 2 MiB more across all 32. An event counts as started, and leaves the 1,000-event count, only once a byte of it is written, and until then
    it is evictable like any other: events behind a full socket drop oldest first, blocked head included (a
    `dropped` count it already carried goes back to the next marker). Retiring connections already keep only their current line, so there's
    no cheap cut left there; lowering the live 34 MiB would cut the 32
    pending 1 MiB replies a client may have, which is a protocol change.
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
| Pinned (Top Apps tiles, pinned rows, tile folders) | pin kind, pinned URL, tile folders, Top Apps sharing | `session.json` (`pinChoices`, `pinSync`, `parkedPins`), sync | ✅ `apply` `tab.pin`/`tab.unpin`, `tabs.setPinnedUrl`, `tabs.returnToPinnedUrl`; 🗺️ tile folders |
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
| Favicons | icon per page | Chrome's Favicons database, app cache | 🗺️ `favicons.get` |
| Shared folders | groups backed by a folder, their identities | `shared-folders.json`, `.ardia-folder.json` | 🗺️ `sharedFolders.*` |
| Live folders | GitHub, calendar and document sources | `live.json` | 🗺️ `live.*` |
| Sidebar layout | width, side, pinned collapsed, auto-hide | `settings` (`sidebarWidth`, `sidebarSide`, `autoHideTabs`), profiles (`pinnedCollapsed`) | ✅ through `settings.set`, `profiles.update`, `windows.setLayout` |
| Presets and themes | setup codes, profile looks, theme files | `settings`, `themes/*.json`, profiles (`theme`) | ✅ `profiles.setLook`; 🗺️ `presets.apply` |
| Omnibox | providers, bangs state, approvals | `settings.omniboxProviders`, `bangs-state.json`, `automation-approvals.json` | ✅ providers through `settings.set`; 🗺️ bangs |
| Session and restore | the whole workspace | `session.json` | ✅ through the areas above; ⛔ the raw document |
| Reader | text size, font | `settings` (`readerTextSize`, `readerFont`) | ✅ `settings.set` |
| Air traffic (link routing rules) | rules per source app | `air-traffic.json` | 🗺️ `airTraffic.*` |
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

`settings.set` takes the same keys and values `config.json` does (`state/settings/configAllowlist.ts`, checked by
`checkedSettings`), applied with `updateSettings`, so a value the Settings UI can choose is a value the command can set.
The keys `config.json` can't set stay off `settings.set` and have their own methods where it makes sense:
`defaultProfileId` is `profiles.setDefault`, `customSearchEngines` is `search.*`. `cliControl` stays refused (the
command can't switch control itself on or off), and so does `allowJavaScriptFromAppleEvents` (it would let any
AppleScript run script in every page). `pageEngine`, `websiteEngines`, `protectedVideoInWebKit`, `newTabUrl`,
`customSearchUrl` and `extensionSearchEngines` are refused in this first round, as `run` refuses `changesEngine`; they are
listed under Next.

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
network, last four and expiry), and removes a saved login, behind the same consent as every other method. It never returns a password, a full card number or a cookie value. When the profile's password manager is a plugin
(Settings › Profiles › Passwords, `currentManagerPlugin` in `state/site/passwordManager.ts`, following profiles that
share data and private windows' own profile), `passwords.list` and `passwords.remove` answer `password_manager_plugin`
"This profile's passwords are kept by <plugin>; Ardia's own password store isn't used.": Ardia's store is empty or
stale then, so an empty list would mislead. `cli_socket_password_manager_refusals` counts those refusals (never which
plugin or profile).

**Why:** "every single data point" covers knowing what is saved and cleaning it up, and those reads carry nothing an
attacker could log in with. Revealing a password in Ardia's own UI asks macOS for the user's password or Touch ID
(`unlockPasswordsFor`); a socket method that did the same would put that system prompt on screen with no context of
which program asked, and anything that can reach the socket (every process of the user) could ask. Cookie values are
the user's live sessions on every site. Both are a different consent than "control Ardia".

**Next, if the owner wants it:** `passwords.reveal {origin, username}` behind its own switch in Settings › Advanced
(off by default) and the macOS re-auth on every call, with Ardia's own sheet naming the program first. It follows the
same rule: a profile whose passwords a plugin keeps answers `password_manager_plugin`, naming the plugin.

## Next

Designed, not built in this round, each in its own file under `state/automation/socket<Area>.ts`:

- **Window geometry:** `windows.setFrame {window, frame}`, `windows.setMaximized`, `windows.setFullScreen`. The store's
  `frame`, `maximized` and `fullScreen` follow the native window (`windows/windowSync.ts`), so these need a native
  call that moves the window (`ArdiaWindows`), which doesn't exist yet; `run` covers full screen through its command.

- **Tile folders:** `pins.folders {profile?}`, `pins.createFolder {tabs, name}`, `pins.renameFolder`, `pins.removeFolder`
  through `state/pins/tileFolders.ts`.
- **Favicons:** `favicons.get {url, profile?}` → the cached PNG as base64, through `resolveFavicon`.
- **Shared folders:** `sharedFolders.list`, `sharedFolders.share {group}`, `sharedFolders.stop {group}` through
  `state/sharedFolders/actions.ts`.
- **Live folders:** `live.list`, `live.refresh {folder}`, `live.hide {folder, item}` through `state/live`.
- **Presets:** `presets.apply {code}` through `applySetupCode`.
- **Air traffic:** `airTraffic.rules`, `airTraffic.setRule {app, route}` through `state/airTraffic/rules.ts`.
- **Sync:** `sync.now`, `sync.setType {type, on}`, `sync.setProfile {profile, on}`, `sync.sendTab {tab, device}`
  through `state/sync/engine.ts`.
- **Extensions:** `extensions.install {webStoreId}` (opens the install prompt the user confirms), `extensions.configure`.
- **Settings refused today:** `pageEngine` and `websiteEngines` once a socket write can move open pages between engines as
  the Settings pane does; `newTabUrl` and `customSearchUrl` with the URL checks `apply` uses.
- **Events:** `bookmarks.changed`, `history.removed`, `download.changed`, `profile.changed`.
