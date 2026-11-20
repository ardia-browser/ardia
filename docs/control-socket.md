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
- **Big lists page, and the bound comes first.** `history.search`, `bookmarks.search`, `downloads.list` and `live.items` take `limit`
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
| Windows | kind, profile shown, frame, maximized, full screen, tab layout, auto-hide, sidebar, focus order | `session.json` (`windows`, `windowOrder`), `launch-layout.json` | ✅ `windows`, `windows.*`, frame, zoom and full screen on macOS (`windows.geometry`, `windows.setFrame`, `windows.setMaximized`, `windows.setFullScreen`) |
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
| Settings | the 109 keys of `SETTING_SPECS` (every switch and choice in Settings) | `session.json` (`settings`, `settingsMeta`), sync for the synced ones, `config.json` (read only) | ✅ `settings.*`; 🔍 `extensionSearchEngines` |
| Search engines | default, custom engines, extension engines | `settings` | ✅ `search.*` |
| Site settings and permissions | per-origin content settings (camera, location, notifications, popups, JavaScript, sound, …), zoom per host, preload | Chrome prefs per profile | ✅ `sites.*` |
| Extensions | installed, enabled, pinned, toolbar order, options | Chrome's extension prefs, `sync-extensions.json` | ✅ `extensions.list`, `extensions.install` (the user confirms), `extensions.configure`, `extensions.setEnabled`, `extensions.setPinned`, `extensions.reload`, `extensions.uninstall` |
| Plugins | installed, enabled, consent, tools | `plugins.json`, `Plugins/` | ✅ `plugins`, `plugins.*` (`state/plugins/socketMethods.ts`) |
| Media sessions | now playing per tab, PiP, shares | memory (`state/media/media.ts`) | ✅ `media.list`, `media.control` |
| Sync | folder, devices, synced types and profiles, remote tabs | `sync.json`, sealed `sync-*.nns` | ✅ `sync.status`, `sync.now`, `sync.setType`, `sync.setProfile`, `sync.setOpenTabs`, `sync.devices`, `sync.sendTab`; ⛔ turning sync on or off, the recovery phrase |
| Saved passwords | origin, username, password | Chrome's Login Data (keychain-sealed) | 🔍 `passwords.list` (no passwords); ⛔ reveal, see Secrets |
| Autofill | addresses, cards | Chrome's Web Data | 🔍 `autofill.list` (no card numbers); ⛔ card numbers |
| Cookies and site data | cookies, storage per origin | Chrome's Cookies and storage | ✅ `sites.clearData`; ⛔ cookie values |
| Favicons | icon per page | Chrome's Favicons database, app cache | 🔍 `favicons.get` |
| Shared folders | groups backed by a folder, their identities | `shared-folders.json`, `.ardia-folder.json` | 🔍 `sharedFolders.list`; 🗺️ share, add, sync, stop |
| Live folders | pull request and document folders, their items, hidden and read state, connected accounts | `live.json` | ✅ `live.*`; ⛔ account tokens |
| Sidebar layout | width, side, pinned collapsed, auto-hide | `settings` (`sidebarWidth`, `sidebarSide`, `autoHideTabs`), profiles (`pinnedCollapsed`) | ✅ through `settings.set`, `profiles.update`, `windows.setLayout` |
| Presets and themes | setup codes, profile looks, theme files | `settings`, `themes/*.json`, profiles (`theme`) | ✅ `profiles.setLook`, `presets.apply`, `presets.describe` |
| Omnibox | providers, bangs state, approvals | `settings.omniboxProviders`, `bangs-state.json`, `automation-approvals.json` | ✅ providers through `settings.set`; 🗺️ bangs |
| Session and restore | the whole workspace | `session.json` | ✅ through the areas above; ⛔ the raw document |
| Reader | text size, font | `settings` (`readerTextSize`, `readerFont`) | ✅ `settings.set` |
| Air traffic (link routing rules) | rules per source app, Everything Else | `air-traffic.json` | ✅ `airTraffic.*` |
| Hooks, config, approvals | hook rules, config.json, approvals | `hooks.json`, `config.json`, `automation-approvals.json` | files the user edits; ⛔ approvals |
| Prompts on screen | permission, save password, save address or card prompts per tab | memory (`state/tabs/pageState.ts`) | ✅ `permissions.*`, `passwords.prompts`/`respond`, `autofill.prompts`/`respond` |
| Native menus | page context menus a hidden Ardia captures, the menu bar's static catalog | `OpenSurfaces.swift`, `MenuCatalog` | ✅ `menus.open`, `menus.bar`, `menus.runBar`; menus on screen (`<select>` popups, live context menus, Ardia's menus, WebKit's) aren't socket-visible; 🗺️ the color popup, payment and WebAuthn sheets; ⛔ macOS's own sheets |
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
| windows | `windows.get {window}`, `windows.geometry {window}` | `windows.create {profile?, url?, layout?}`, `windows.close`, `windows.focus`, `windows.setLayout {window, layout?, tabsShown?}`, `windows.switchProfile`, `windows.merge`, `windows.setFrame {window, frame}`, `windows.setMaximized {window, on}`, `windows.setFullScreen {window, on}` |
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
| extensions | `extensions.list {profile?}` | `extensions.install {profile?, webStore}` (the user adds it on the store page; `folder` is refused), `extensions.configure {id, siteAccess \| incognito \| userScripts}` (exactly one; `specificSites` is refused), `extensions.setEnabled {id, enabled}`, `extensions.setPinned`, `extensions.reload`, `extensions.uninstall` (Ardia asks the user first) |
| media | `media.list` | `media.control {tab, action, seconds?}` |
| sync | `sync.status`, `sync.devices {profile?}` | `sync.now`, `sync.setType {type, on}`, `sync.setProfile {profile, on}`, `sync.setOpenTabs {profile, on}`, `sync.sendTab {tab, device}` |
| passwords, autofill | `passwords.list {profile?}`, `autofill.list {profile?}` | `passwords.remove {origin, username}` |
| pins (tile folders) | `pins.folders {window?}` | `pins.createFolder {tabs, name?}`, `pins.renameFolder {folder, name}`, `pins.removeFolder {folder}`, `pins.addToFolder {folder, tabs}`, `pins.removeFromFolder {tabs}` |
| favicons | `favicons.get {url, profile?}` | none |
| sharedFolders | `sharedFolders.list` | none yet; `share`, `add`, `sync` and `stop` are designed under Next |
| live | `live.list {profile?}`, `live.items {folder, limit?, offset?}` | `live.create {kind, profile?, sources?, name?}`, `live.update`, `live.remove`, `live.refresh`, `live.hide {folder, items}`, `live.unhide`, `live.markRead {folder, items?}`, `live.setRepoHidden {folder, repo, hidden}`, `live.open {folder, item, window?}` |
| presets | `presets.describe {code}` | `presets.apply {code, window?}` |
| airTraffic | `airTraffic.rules`, `airTraffic.test {url, from?}` | `airTraffic.addRule`, `airTraffic.updateRule {id, …}`, `airTraffic.removeRule {id}`, `airTraffic.moveRule {id, index}`, `airTraffic.setFallback {open, profile?, group?}` |

`settings.set` takes the same keys and values `config.json` does (`state/settings/configAllowlist.ts`, checked by
`checkedSettings`), applied with `updateSettings`, so a value the Settings UI can choose is a value the command can set.
The keys `config.json` can't set stay off `settings.set` and have their own methods where it makes sense:
`defaultProfileId` is `profiles.setDefault`, `customSearchEngines` is `search.*`. `cliControl` stays refused (the
command can't switch control itself on or off), and so does `allowJavaScriptFromAppleEvents` (it would let any
AppleScript run script in every page).

Five keys `config.json` can't take are set here with the checks their Settings rows apply
(`state/automation/socketSettingRules.ts`), and `settings.schema` reports them writable:

| Key | What the socket checks, as Settings does |
| --- | --- |
| `pageEngine` | `chromium` or `webkit`; `webkit` only where WebKit ships (macOS). The same write the pop-up in Settings › Advanced makes |
| `websiteEngines` | `{site: engine}`, each site typed as the Add Rule sheet takes it (`netflix.com` or a full address) and stored as its scheme, host and port; a value that isn't a website address is `bad_request`. The whole map is replaced, as each sheet edit replaces one rule |
| `protectedVideoInWebKit` | A boolean, the Streaming sites row; macOS only |
| `newTabUrl` | Empty (Ardia's New Tab), or an `http(s)` address, `about:blank` or an Ardia page: the address Settings marks invalid is refused here, not saved. Stored trimmed |
| `customSearchUrl` | The legacy one-URL engine that `search.engines` lists as `custom`: empty clears it (and if it was the default, the default goes back to Ardia's, as removing an engine does, unless the same call chooses `searchEngine`); otherwise an `http(s)` URL with `%s`, and only while no other engine uses the keyword `custom` |

One `settings.set` is checked as the settings would end up: adding `customSearchUrl` and choosing `searchEngine:
"custom"` together works, clearing it while choosing `custom` is `bad_request`, and a `searchEngine` named in the
same call wins over the fallback.

`extensionSearchEngines` stays read only: it mirrors the engines installed extensions provide, Settings has no
control for it, and a written value would be overwritten from the extensions on the next refresh. Change it through
the extension (`extensions.setEnabled`, `extensions.uninstall`).

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
- **Shared folders** (`state/sharedFolders`). `sharedFolders.list` reads the sidebar's folders backed by a folder on
  disk, with each one's path, file URL, groups, link count and sync state; nothing over the socket writes to a shared
  folder yet (see Next). The sidebar's own sync goes through the native layer (`SharedFolderDirectory.swift`), which
  opens the root once with `O_NOFOLLOW`, checks its device and inode, and does every scan, read, write, rename, mkdir
  and unlink relative to folder descriptors it holds while descending (`openat`, `fstatat`, `renameatx_np`,
  `unlinkat`), so a root or subfolder swapped after the check is never followed. Binding is compare-and-set: whichever
  finishes making a folder second keeps the first one's binding and removes its own.
  A group bound to a shared folder syncs to disk whenever it changes, so the socket leaves it alone, with one
  choke point (`socketSharedChokePoint.ts`). Every request for a method the catalogue marks as changing something
  (`mutates`; every method declares it, and a test fails if one doesn't), `run` and plugin methods included, runs in a
  socket-origin context. Its first synchronous stretch, and each stretch that resumes after an await and re-checks
  control through `stillOn` before it changes anything, is checked when the stretch ends, in the next microtask. The check
  compares the synced projection of every bound group and everything inside it, which is exactly what the
  shared-folder engine would write: each link's name and URL, their order, and nested groups. If it changed, only the
  bound groups' trees go back: their groups, member tabs, the splits those tabs are in, and their places and the active
  tab in their windows. Everything else stays as it is now. The request then answers `refused` ("shared folder groups
  change only from the sidebar"). A write that isn't the socket's and can land while a check is open goes through a hook that ends the open check
  first (refusing the request if the socket had already changed the projection), makes the write, then opens the
  check again on the result: the shared-folder engine's merge (`syncWriteHooks`), and the sidebar's and other UI writes
  that follow an await, such as a close confirmed in a sheet, a rename typed into a prompt, or a profile picked from a
  menu, and a finished download's move (`foreignWriteHooks`). So neither is undone or blamed on the socket, and neither
  absorbs the socket's own change. Commands a person runs (the menu bar, shortcuts, the app menu, the command bar and
  launch actions) pass no guard to `runCommand`, so their writes after an await go through `foreignWriteHooks` too;
  only the socket's `run` passes its guard. A stretch of another request starting while a check is open ends that check first, so each check covers one
  request. A guard called after its request has answered (a live refresh that goes on, the guards handed to
  `goBackAsking` and `closeWindowAsked`) only checks control and opens no check. Read-only requests open none either.
  Muting, sleeping, activating, colour, icon and collapsing don't touch the projection, so they still work, and so do
  closing or parking a window that shows the folder. A socket-reachable action that awaits before it writes the store
  takes the request's guard and calls it after each await, or, when the write is a person's answer to a sheet, menu,
  prompt or picker, makes it through `foreignWriteHooks`. `scripts/socketGuardLint.mjs` checks this with the TypeScript
  compiler. It starts from every function in `state/automation` and `run`'s command table and follows calls, plain
  wrappers of async helpers, store actions reached through helpers, destructuring or an alias of the store hook, and
  every nested function: `.then`/`.catch`/`.finally` and timer, microtask and listener callbacks as running later,
  array callbacks and hook wrappers in place, up to five calls deep. It fails on any store write after an await that
  isn't preceded by a guard call, and on `foreignWriteHooks.around` or `syncWriteHooks.around` reached in the socket's
  own stretch, which would close its open check before the socket's write (`socketGuardLint.test.mjs`, which names the
  one known-safe site and why). `run` answers synchronously, so a guard called after an await inside one of its
  commands opens no check: `run` `closeTab` and `closeTabGroup` on a shared folder's tree are protected by the
  up-front refusal below, not by the check. Earlier, more specific refusals remain where they read better or where a rollback
  can't reach, because the action reaches a page or the engine before any check runs:
  - `apply`'s per-op check (`workspaceSharedGuard.ts`);
  - `pins.createFolder` and `pins.addToFolder` for a member;
  - `tabs.navigate`, `tabs.back`, `tabs.forward` and `run` `back`/`forward` on a member with no pinned home;
  - `run` `closeTab` and `closeTabGroup` when the tab or its group is in a shared folder's tree;
  - `profiles.delete` of a profile that has a shared folder;
  - `airTraffic.addRule`/`updateRule` for a group in a shared folder's tree.
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

`subscribe` sends tab, window, split, peek, pin, profile and settings events (`eventNames.ts`). Writes here change the
store, so those events fire for them as for a click. `bookmarks.changed`, `download.changed` and `profile.changed`
are store watches and `history.removed` listens to the engine's history (`libraryEvents.ts`, started from
`storeEvents.ts` only while a connection or plugin asks for one of them); their fields are in `docs/automation.md` ›
Events. No protocol change: an older command never names them.

Every URL an event carries, `url` or the `urls` of `history.removed`, is cut to origin and path for a socket
connection or plugin without `fullUrls` (`eventRedaction.ts`, used by both delivery paths). `history.removed` keeps
its whole line, escaped JSON, envelope and newline included (measured with `socketWire.ts`'s `frameBytes`), plus
the room `socketWire.ts` keeps for a `dropped` marker (`DROPPED_MARKER_ROOM`), under 256 KB: `urls` stops at 1000 entries or where the next one would pass that, `count` stays the full number, and
`truncated: true` says some were left out. The 1 MiB line limit, the output budgets and the `dropped` marker are the
socket's own (`socketWire.ts`, `ControlOutput.swift`), the same for every event.

### Sync

The sync methods call `state/sync/engine.ts` as Settings does, and each refuses while sync is off, unavailable or
locked. The writes (`sync.now` and every `sync.set*` and `sync.sendTab`) also refuse while sync is starting (its
saved state isn't loaded yet) or turning off (Settings still shows it on during the last pass), so an `ok` is never
dropped afterwards. `sync.now` answers after a pass that started after the call: when a pass is already running it
waits for that one, then runs its own. Right where that pass would start it checks again: if sync began turning off
meanwhile it answers `refused` and starts nothing (the retiring pass is the last), and if control turned off it starts
nothing. `sync.setProfile` needs the profile's sync link (it appears on the first sync after the profile opens; the
Settings toggle is disabled until then), and `sync.setOpenTabs` needs the profile on and Open Tabs syncing, as the
Sync All Open Tabs toggle does. `sync.sendTab` takes an `http(s)` tab and a device from `sync.devices`, the list the
tab menu's Send to Device shows. Turning sync on or off and the recovery phrase stay in Settings: they choose a
folder and show or ask for the phrase, which is the user's to see.

### Extensions

`extensions.install` takes a Chrome Web Store link or id (`webStore`, checked as Add from a Link checks it) and
opens the extension's store page in a window of that profile, where the user adds it; it answers `{waiting: true, id}`,
or `{installed: true, extensions}` when the profile already has it. Each step after an await re-checks that control
is still on and the profile still exists, and answers `failed` or `no_window` without changing anything otherwise;
that covers the store tab and the already-installed answer.

Installing an unpacked folder from the socket isn't supported, on any platform. A string `folder` is `refused`
("installing an unpacked folder from the socket isn't supported; use Settings › Extensions › Load Unpacked") before the
path is checked or anything is read; a `folder` that isn't a string (`null`, a number) fails schema validation first
and is `bad_request`. Settings › Extensions › Load Unpacked loads the chosen folder in place, as on `main`. Its native
path differs from `main` in exactly two places: the shared manifest reader (`ReadManifest` in
`ArdiaExtensionPackage.mm`) also reports `incognitoAllowed` (false only for `"incognito": "not_allowed"`), which
therefore also appears in Load Unpacked's folder inspection, and `listExtensions` in `ArdiaServices.mm` copies it into
each list row, as `null` when the installed manifest couldn't be read.

*Removed:* earlier revisions of this change installed socket folders from a private hashed copy; that was dropped,
since Chromium rereads an unpacked extension's folder by path, so only an engine-owned snapshot could make it sound.

The install sheet that Settings and Web Store prompts show keys each request, so its Add button and Return confirm
that request only. Once Add is pressed the sheet shows Adding… with Cancel greyed out, and nothing else replaces it:
a Web Store prompt that arrives meanwhile waits and shows after, in its own window if that can still show a sheet and
isn't private, otherwise in another open main window or Little Ardia window (both host the install sheet) that isn't closing
(mid-animation or marked for close), or it is declined. If the window under a sheet closes before Chromium
answers a failed add, no error sheet is left behind for it.

`extensions.configure` changes exactly one setting per call, as an extension's page in Settings does: site access
(only for an extension that asks for sites), Allow in Incognito, or Allow User Scripts (only when the extension uses
them). The params schema takes exactly one of them (an `anyOf` of one form per setting), so a request naming none, or
more than one, fails validation as `bad_request` before anything is read or written; a policy-installed extension is
`refused`. The expected result is computed from the request before the write. Each call is checked against a list
read from Chromium for the call, never the cached row, makes its one write, and takes the list that Settings' own
`configureThenRead` reads once after that write as its only readback: if that read fails, the extension is missing
from it, or the setting isn't exactly what was asked, the call answers `failed` and nothing else was touched. There is no rollback, so a refused or
silently declined change can't take a user's site grants or later changes with it.

`siteAccess` takes `allSites` or `onClick`. `specificSites` is `refused` ("changing to specific sites needs engine
support") before anything is written: turning site access to specific sites makes Chromium withhold host
permissions, and withholding removes every revocable host grant, so even a request naming exactly the sites already
granted would lose them, and the engine's configure call can't grant sites back. The follow-up is an `engine/`
change: `ac_extensions_configure` taking the hosts to grant.

Allow in Incognito is checked first for eligibility: when `incognitoAllowed` is missing (Linux and Windows rows don't
carry it) or `null` (macOS couldn't read the manifest), any Incognito change is `refused` ("can't confirm incognito
eligibility"), and that includes an unpacked extension whose eligibility is unknown. An unpacked extension with a
readable manifest is then `refused` ("needs engine support"): its manifest on disk can differ from the one Chromium
loaded, and Chromium's own eligibility flag (`incognito_access.is_enabled`) isn't exported by `ac_extensions_list`.
A packed or Web Store extension whose manifest says `"incognito": "not_allowed"` can't turn it on. Otherwise the
Incognito write is read back, so a change Chromium declines without an error answers `failed`.

### Window geometry

`windows.geometry`, `windows.setFrame`, `windows.setMaximized` and `windows.setFullScreen` call four public
functions of the `ArdiaAppWindows` module in `packages/shell` (`WindowGeometry.swift`, typed in
`packages/shell/src/windows.ts`, wrapped in `platform/windows.ts`): `windowGeometry(id)`, `setWindowFrame(id, frame)`,
`setWindowZoomed(id, on)` and `setWindowFullScreen(id, on)`, each answering the window's geometry afterwards:
`{frame, zoomed, fullScreen, pageFullScreen, miniaturized, visible, display}`, plus `refused: "offscreen" |
"invalid"` when `setWindowFrame` left the window where it was. They are the extension point for anything in the app or
a plugin (through these socket methods) that moves windows; nothing about them is socket-only. Frames are AppKit's: screen points from the
bottom-left of the main display, the same as `frame` in `windows`. A frame is kept on the display it overlaps most and at
least the window's smallest size; a frame that overlaps no display, or isn't finite with a positive size, is refused
by the native call itself, and the socket also bounds every coordinate to ±100,000 points. Zoom is macOS's (the
green button with Option, or double-clicking the title bar). `setWindowFullScreen` answers once the transition has
finished, not when it starts. `FullScreenLifecycle.swift` tracks every window's transitions, whoever starts them (a
call, the green button, the menu or a keyboard shortcut): `willEnter`/`willExit` opens one and gives it a generation
number, and the window closing ends it. `didEnter` or `didExit` ends it only when the notification's own direction
matches the open transition's and the window's real full-screen state (`ArdiaChromeWindowHost.windowIsFullScreen`, the
style mask, plus the stand-in a background test instance acts out) matches it too; otherwise the notification is stale
(a late end of an earlier transition) and is ignored and logged. WindowManager's cached full-screen flag takes the same
decision (`acceptsEnd`), so a stale notification can't set it either. Chromium's failure callbacks don't end one (its exit-failure callback arrives before `didExit`). A
transition with no ending notification is checked against the same real state from 6 s on, once a second: it ends
when two checks agree, whichever side that is, and after 30 s it ends regardless and is logged. Either way the
window's cached full-screen flag is set to that real state (and the store told), so geometry and later calls see
it. While a transition is open, a call answers `transition: "busy"` (the
socket's `refused`). A call is settled only by a transition whose generation is newer than the last one when it
toggled, so a late notification can't answer a newer call. After 6 s a call answers `transition: "timeout"` (the
socket's `failed`, "Timed out…"), and the window stays busy until that transition ends. The socket runs one full-screen change at a time per window, checks the final geometry
against the request, waits for the store to follow (`failed` if it doesn't within 4 s), and answers `refused` while a
page is full screen in the window, `failed` if the window didn't get there. None of the three acts while a page is full screen in the window. The store's `frame` and `fullScreen` follow through the
window events they already listen to. `PLATFORM_FEATURES.windowGeometry` is on for macOS only: Linux needs the same
four calls in `engine/ardiacore-linux` (an engine change, so a new engine), and Windows in `WindowManager` of
`apps/browser/windows` (its maximize already exists as `toggleMaximizeWindow`); until then the methods are `refused`
there.

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

## Native UI: prompts and menus

Some of what a person answers in Ardia isn't a page and isn't in a store: a permission prompt already on screen, a
`<select>` popup, a context menu, the menu bar. DevTools can't answer them (issue #2812, rows 3, 14,
16 and 17), so the socket does, through the same decision path the native UI uses. Every method here is in `methods`
with its schema, refuses plugin sessions at the dispatcher check point, stops writing when control is turned off, and
counts in `cli_socket_calls_permissions`, `cli_socket_calls_menus` or `cli_socket_calls_secrets`.
They need native API 86 on macOS (`NATIVE_API_VERSION` and `AppModule`'s `apiVersion`): the static menu catalog,
`performMenuBarItem(ref, windowId)`, the captured page menus and the autofill answer the native layer confirms. #2841
took 83, #2811 takes 84 and #2816 takes 85, merging in that order before this one.

Until the engine items listed under "Needs engine code" land, the socket **lists** prompts and captured page menus but
**doesn't answer** permission or password prompts or **pick** from a captured menu: those methods answer `refused`
with a message naming the engine work. Only captured background menus are listed; a menu on screen (a `<select>`
popup, a live context menu, Ardia's or WebKit's) isn't socket-visible at all. The menu bar is reached through its
static catalog and is refused while any private window is open. Autofill prompts and the menu bar otherwise are
answered as described below.

| Method | Mutates | What it does, and the path it takes |
| --- | --- | --- |
| `permissions.prompts` | no | The prompt each tab shows (`{id, window, tab, origin, permissions, queued}`); `queued` counts the prompts waiting behind it |
| `permissions.respond {id, decision}` | yes | **Refused for now**, for every decision, with a message naming the engine work: the engine reports nothing about what an answer did (an answered prompt posts no dismissal; embedded-prompt dismiss branches, policy, embargo, storage-access scoping and omitted kinds can all differ from what was asked), and a setting read back can't tell an answer from a setting that already matched. Needs a resolve result and a one-time grant (`ac_permissions.mm`, below). `no_window` for a prompt not on screen. The prompt on screen answers as before |
| `passwords.prompts` | no | Save and update password prompts: `id` (Ardia's, new for every prompt a tab shows), origin, state, username, at most 20 of the usernames an update offers as `{id, name}` and `usernameCount`; never the password or its length. A username's `id` is a token of the prompt's id and that username (`u-` and 16 hex digits), never a position, so it can't name a username of another prompt; `name` is cut to 256 characters |
| `passwords.respond {tab, id, decision, usernameId?}` | yes | **Refused for now**, with a message naming the engine work: the engine names no offer and doesn't say whether an answer took, and an app-side number can outlive its offer (Chromium's manual-save fallback replaces the form without a new bubble, and a queued Save can follow a Dismiss). Needs an offer id and a resolve result (`ac_password_prompt.mm`, below). `no_window` when the tab shows no prompt or another one. The prompt on screen answers as before |
| `autofill.prompts` | no | Save address, update address and save card prompts: the engine's `id`, origin, `kind`, `fields` (for an update: which of name, address, email, phone, other change) and a `description` Ardia writes from those. Never the engine's text (an update's summary holds the name and street), the address lines or the card |
| `autofill.respond {tab, id, decision}` | yes | `accept`, `decline`, `dismiss`. `no_window` when the tab now shows another prompt or its page is gone; `failed` when the engine's prompt id no longer matches or it stays open after the answer |
| `menus.open` | no | **Captured page menus only**: a page's context menu that a hidden Ardia captured as data (`kind: "page"`, `captured: true`), with the tab and window it came from, recorded when it was captured, and its items (`path`, `title`, `enabled`, `checked`, `separator`, `submenu`). It is listed only when that window and tab are ones the ardia command may use. Nothing else is socket-visible: a menu on screen (a page's context menu, a `<select>` popup, Ardia's own menus, a WebKit context menu, a tracking menu bar, any menu whose items target a class the app doesn't know) has no proven source, so it gets no id, no entry and no event. The menu bar is reached only through the static catalog in `menus.bar` |
| `menus.choose {menu, path, ref?}` | yes | **Hidden from `methods`** (its spec is `hidden`); the handler stays for older clients, with its schema and consent checks. A captured page menu answers `refused` until the engine runs a captured item for its own frame. Any other id, whether it names a menu on screen or nothing at all, answers exactly as an unknown id: `no_window`, "There's no open menu with that id", by the same path. To run a menu bar item, use `menus.runBar` with a row from `menus.bar` |
| `menus.dismiss {menu}` | yes | Drops a captured page menu from the list and sends clients nothing (nothing on screen closed). Any other id answers exactly as an unknown id does |
| `menus.bar` | no | A **static catalog** of the menu bar, generated from its definition, never from the live `NSMenu`: `MainMenu.build()` hands its freshly built tree to `MenuCatalog.capture` before anything state-driven fills it, and before it assigns `NSApp.windowsMenu` (AppKit copies the open windows' rows into a new Window menu at that moment, so a rebuild with a private window open would otherwise capture its title); the capture also drops any row whose target or represented object is a window. The catalog is kept from then on. Each row has its path in that definition, `ref`, the static title it was built with, its default shortcut (`key`), and its `command` and `arg` when `run` takes it or its AppKit `action`; no enabled, checked or hidden state and no page-derived titles. Menus built from open windows, profiles, pages or history (Services, Share, Move to Profile, Move to Window, Add Bookmark to Folder, Profiles, New Little Ardia Window in Profile, History, Extensions) are one row each with `dynamic: true` and no items; Bookmarks and Window list their static items followed by one `dynamic` row for their saved bookmarks and open windows. So the catalog is the same bytes whatever is focused, open or private. Still refused while any private window is open |
| `menus.runBar {path, ref, window?}` | yes | Runs a row of `menus.bar`, found by its `ref` (its `path` must match). A `dynamic` row, a submenu or a separator doesn't run. An Ardia command goes straight to `runMethod`, exactly as `run`: it first refuses everything in a background Ardia (#2811), then applies the command policy (`needsPerson` and the rest) before it resolves the named window, and then runs against that window's store state, with no menu validation (`validateMenuItem` and the cached menu state never decide), so the automation policy applies (`automationCommands.ts`: no Quit, no engine switch, no Allow JavaScript from Apple Events, no command that needs the person, the settings `config.json` can't set). **In a background Ardia `menus.runBar` runs nothing**: `run` refuses every command there (#2811), and every native item is refused too. Any other item is a native one, dispatched with no validation step to an explicit target the catalog recorded: the named window itself when it is the key window, or, for Minimize All and Arrange in Front, the app or the item's own `MenuTarget` handler; the target's own handler decides. With no key window every native item is refused; an item that only works along the responder chain (Undo, Copy, Paste, Select All, spelling and substitutions, Keep Window on Top) is refused, and so is everything off the `MenuBarAction` allowlist (Quit, Hide, Close Window, Check for Updates, system input, Check Document Now, Show Substitutions…). Everything is refused while any private window is open, checked in JS right before `run` with no await in between and natively in the turn that dispatches |

**Events:** `permission.prompted` (`{id, windowId, tabId, origin, permissions, queued}`), `password.prompted`
(`{id, windowId, tabId, origin, state, username, usernames, usernameCount}`, the same capped list; named only, not in `"*"`), `menu.opened` (`{id, kind, windowId, tabId, items}`, `items` being a count). There is no close event: a captured menu never shows on screen, and its drop sends nothing. None of
them reach plugins.

**Commands that need the person.** `run` never starts a command that opens a picker, dialog, wizard or sheet only the
person can finish: they are `needsPerson` in `automationCommands.ts`, so `commands` leaves them out and `planRun`
refuses them before any window is resolved (never `no_window`), with "<command> needs the person to finish it", in
every instance. They are `openFile`, `exportBookmarks`, `savePage`, `print`, `printWithSystemDialog`, `newProfile`,
`clearBrowsingData` (its dialog), `importBrowserData` (the import wizard), `cast` (the device picker), `pinExtensions`
(its dialog), `autofill` (the suggestions picker), `share` (the share picker or a compose sheet), `emailPageLocation`
(a Mail compose window), `tabSwitcher`, `openProfileMenu`, `hideElement` (the element picker), `toolTour`,
`showOnboarding`, `reportProblem`, `changeTabIcon` (the icon picker), `caretBrowsing` (its confirmation), `bookmarkAllTabs`
(its dialog creates the bookmarks only when the person finishes it) and `renameTab` (a pinned tile's rename is a native
prompt; the socket renames tabs with `apply`'s `tab.rename` op). Checked and
left to run, because they finish on their own or only open a window or page: the Settings, Keyboard Shortcuts,
Downloads, History, Bookmarks, Task Manager and Extensions windows, the Web Store, release notes and video tour pages,
`bookmarkPage` (it saves at once), copying, find, zoom,
navigation, tab, group, split, sidebar, DevTools and profile-switching commands.

**Opening a file the socket names is allowed.** `apply`'s `open` op, `windows.create` and `tabs.navigate` load `file:`
URLs (`file:///…` and `file://localhost/…` both pass `openableUrl`; there is no `tabs.open`). That is full control by
design: it loads a file the caller named, in a tab, and opens no picker. `downloads.open`, which hands a download to an
external app, lives in `socketDownloads.ts` (#2811).

**What `run` already covered.** `run` and the `commands` catalogue cover every Ardia command in the menu bar; what was
missing was the menu as data (which items exist, under which menus, with which shortcuts) and the menu items that
aren't Ardia commands (Window). `menus.bar` and `menus.runBar` add only those, from the static catalog.

**How it works.** `OpenSurfaces.swift` (in `packages/shell`) keeps only what a hidden Ardia captures: the engine hands a
page's context menu to the app (`-tab:runContextMenu:`), and the app records it with the tab and window it came from.
It doesn't watch AppKit menu tracking at all, so a menu on screen, whoever shows it (Chromium's `MenuControllerCocoa`
or `WebMenuRunner`, WebKit's `WKMenuTarget`, Ardia's own menus, the menu bar), never gets an id or an event: none of
them says which tab and window it belongs to, and a guess from the key window could credit it to the wrong one. The
menu bar is the static catalog in `menus.bar`, and `menus.runBar` runs from it.

**Background mode.** A hidden instance (`ARDIA_BACKGROUND=1`) doesn't show a page's context menu: the engine hands it to
the app (`-tab:runContextMenu:`). While the socket serves, the app captures the menu as data (`ArdiaPageMenuCaptured`:
the tab, its window, the link and the items) and returns at once, so the engine closes its menu
as before; no nested run loop holds it. A captured menu is listed by `menus.open` and announced by `menu.opened`, lasts
60 s, is replaced by the next one and is dropped when control turns off or the menus module goes away. A drop (replaced,
expired, dismissed, control off) sends clients nothing; the internal `menuDropped` notice reaches no client. Picking from it
is refused: the engine's menu doesn't say which frame it came from, and nothing the app can read (the main world's
`document.activeElement` included, which the page controls, misses closed shadow roots and can change between a read
and the dispatch) binds an edit to that frame. Without a serving socket the menu is logged as before. A `<select>`
popup is a real AppKit menu in either mode, so it isn't socket-visible.

**Needs engine code (joins the engine/next build or a later key).** These change `engine/ardiacore/src/ardia/core`,
which is frozen outside the engine/next build (#2328, #2808), so they move the engine key and aren't in this change.
Until they land, answering prompts and picking from captured menus are refused; listing them works.

Needed for the full feature:
- *Frame-bound captured menu commands* (`ac_context_menu.mm`), for `menus.choose` on a captured menu.
  `ACContextMenu::ShowThroughHost` keeps, per tab, the menu's `ContextMenuParams`, the `GlobalRenderFrameHostId` it was
  built for and that frame's `document_token`, for 60 s, and passes a token for it in the `runContextMenu:` dictionary
  (`@"menu"`). A new `-[ArdiaCoreTab runContextMenuCommand:(int)command menu:(NSString *)token flags:(int)flags]`
  rebuilds an `ACContextMenu` for that frame with those params and calls `ExecuteCommand` when `IsCommandIdEnabled`,
  returning NO when the frame is gone, its document changed, the token was replaced or the time ran out. Until then:
  listed, every pick refused.
- *A password offer id and a resolve result* (`ac_password_prompt.mm`), for `passwords.respond`. `PasswordPrompt(contents)`
  adds `@"offer"`, a number the engine increments each time the `PasswordsModelDelegate` enters
  `PENDING_PASSWORD_STATE` or `PENDING_PASSWORD_UPDATE_STATE` and each time its pending form is replaced (the
  manual-save fallback included), kept on the `WebContents` as user data; `ResolvePasswordPrompt(contents, action,
  username, password, offer)` returns `bool`: false when `offer` isn't the current one, the bubble was already
  answered, or `action` isn't one of the current state's buttons (`save`/`never` pending, `update`/`nope` pending
  update). `-[ArdiaCoreTab resolvePasswordPrompt:username:password:offer:]` returns that `BOOL`. Until then: listed,
  answering refused.
- *A permission resolve result and a one-time grant* (`ac_permissions.mm`), for `permissions.respond`.
  `ACPermissionPrompt::Resolve(result, remember)` returns what it did (`kAccepted`, `kAcceptedOnce`, `kDenied`,
  `kDismissed`, or `kNotCurrent` when `!Current()` or already answered), including what `Apply`'s embedded-prompt and
  already-allowed branches turned the answer into; `ResolvePermission(request_id, result, remember)` passes it out,
  and `+[ArdiaCoreEngine resolvePermission:result:remember:]` returns it as a string. `Apply` takes an explicit
  `acceptOnce` that refuses (`kNotCurrent`) unless every request `DoesSupportTemporaryGrants`, instead of falling back
  to a lasting `Accept`, and `AskHost` names an unknown kind `other` rather than leaving it out. Until then: listed,
  answering refused.

Can wait:
- *An explicit autofill result* (`ac_autofill_prompt.mm`). `ResolveAutofillPrompt(contents, prompt_id, action)` returns
  whether that prompt was answered; today the app reads `autofillPrompt` again and treats a closed or replaced prompt
  as answered.
- *More captured commands.* With the frame-bound command above, every item of a captured menu (Open Link in New Tab,
  Copy Link, Save Image As…) runs for its own frame.

**The color picker is Blink's, not AppKit's.** The issue's row 14 expected `NSColorPanel`, but in this Chromium a web
page never reaches it on desktop: `WebContentsDelegate::OpenColorChooser` is compiled only for Android and iOS
(`content/public/browser/web_contents_delegate.h`), and nothing on the browser side calls `ColorPanelHost`, so
`color_panel_bridge.mm` is unused. Clicking `<input type=color>` opens Blink's own HTML picker
(`ColorChooserPopupUIController`, `color_picker.js`) in a page popup window, measured in a hidden instance as a new
230×248 window owned by Ardia. That popup isn't a DevTools target and its layout is Blink's private HTML, so the app
can't choose in it reliably by synthesizing clicks. **Designed, needs engine code (joins #2808 or a later key):** a
hook where `RenderWidgetHostImpl` shows the page popup for a color input (`g_ardia_page_popup_shown`) that hands the
app the popup's widget, plus `ac_color_popup_set_value(widget, rgb)` calling the popup's own
`pagePopupController.setValue` path, as a person's choice in it does; the socket then gets `menus.open` entries of kind
`color` and `menus.chooseColor {menu, color}`. Whether DevTools key events reach the open popup (a person can type a
hex value into it) wasn't measured here; row 14's run found no keyboard path for color.

### Payment, passkey and password sheets

| Sheet | Who shows it | Socket |
| --- | --- | --- |
| Save or update password, save address or card | Ardia (`Prompts.tsx`, from `ac_password_prompt.mm` and `ac_autofill_prompt.mm`) | ✅ listed and answered above |
| Payment sheet (`PaymentRequest.show()`) | Chromium's views dialog (`PaymentRequestDialogView`, from `ChromePaymentRequestDelegate::ShowDialog`), not Ardia | 🗺️ needs engine code |
| Chrome's WebAuthn sheet (choose a passkey, phone, security key) | Chromium's views dialog (`AuthenticatorRequestDialogView`) | 🗺️ needs engine code |
| iCloud Keychain passkey sheet, Touch ID, the macOS password prompt | macOS (`ASAuthorizationController`, `LAContext`) | ⛔ macOS owns it; the socket can't list or answer it |
| Print preview | Chrome's `chrome://print` dialog (`PrintPreviewDialogController`) | CLI: attach to the `chrome://print` target once #2808 opens `chrome://` targets |

**Payment sheet, designed.** Ardia doesn't own it today: `ChromePaymentRequestDelegate::ShowDialog` builds Chromium's
views dialog over the page. To answer it the engine needs a hook beside `g_ardia_create_permission_prompt`
(`g_ardia_payment_dialog`) that hands the sheet's state to the app: merchant origin, total and its label, the payment
apps on offer (by name, never their instruments). The app then shows Ardia's own sheet, and the socket gets
`payments.sheets` and `payments.respond {id, decision: pay|cancel, app?}`. Paying with an installed payment app only
starts that app (its window asks for anything secret); the socket never sees card data. This is engine work and joins
#2808's build (or a later engine key); it is not in this change. Until then `PaymentRequest.show()` behaves as Chromium
does, and the test page's `https://127.0.0.1/pay` method has no app, so it rejects with `NotSupportedError` before any
sheet.

**Passkeys, designed.** Chrome's own WebAuthn sheet is views UI and needs the same kind of engine hook
(`g_ardia_authenticator_dialog`) before Ardia can list its steps (choose a passkey, use a phone, a security key) and the
socket can pick one. Creating or using a passkey then goes to macOS: the iCloud Keychain sheet and Touch ID belong to
macOS, can't be answered by any app, and shouldn't be: they are the proof that the owner is present. So the socket stops
at listing Ardia's own step, and the owner touches the sensor. A virtual authenticator (`WebAuthn.addVirtualAuthenticator`
over DevTools) remains the way to test, never the owner's real keys.

## Next

Designed, not built in this round, each in its own file under `state/automation/socket<Area>.ts`:

- **Window geometry on Linux and Windows:** the four `ArdiaAppWindows` calls above, then `windowGeometry: true` in
  their `PLATFORM_FEATURES`.
- **Shared folder writes:** `sharedFolders.share {group, parent?}`, `sharedFolders.add {path, window?}`,
  `sharedFolders.sync {group}` and `sharedFolders.stop {group}`, in #2836 (`full-control/app-socket-2a-shared`), which is
  parked: review found data-loss bugs in the shared-folder sync engine and its native layer, and fixing them changes the
  sidebar's own shared-folder sync, so they need their own focused PR first. The open findings are listed at the top of
  #2836.
- **Native UI, engine side** (with #2808's build or a later key): the payment and WebAuthn hooks above; the context
  menu's checked state in `DescribeMenu` (`ac_context_menu.mm` reports enabled and visible only); the tab and window that
  showed a live context menu or a `<select>` popup, passed with it, so those can become socket-visible; the color popup
  hook above.
