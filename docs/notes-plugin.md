# Notes (plugin)

A Notion-grade notes plugin for Ardia: pages made of blocks, the `/` menu, databases with every Notion view, nested
pages, comments, mentions, version history, trash, favorites, templates and live collaboration, drawn in Ardia's
theme. Notes open at `ardia://notes/…`, so the address bar, history, back and forward, and reopen-closed-tab work as for
any page, and the command bar (new tab included) finds notes by their full text beside web results.

It is a plugin (`plugins/notes`), not part of the base browser: everything it needs from Ardia is a public extension
point any plugin can use (below). Mac only for now, as every plugin (`PLATFORM_FEATURES.plugins`).

## Parts

```
plugins/notes/
  plugin.json            manifest (manifest 2)
  build.mjs              builds dist/index.js (main) and page/ (the web app), offline, no CDN
  src/shared/            used by main and the page: the data model over Yjs, the wire protocol, text extraction
  src/main/              main (ArdiaPluginHost): storage, sync, search index, omnibox, commands, the page bridge
  src/page/              the web app shown in the page tab (React + BlockNote)
  src/page/client/       the page's NotesClient: bridge.ts (real, over window.ardia) and mock.ts (in memory, for dev)
  src/page/database/     databases and their views
  tests/                 node tests (model, sync between two devices, search) and Playwright tests of the page
```

Owners while it is being built: platform agent (Ardia app changes), core agent (`src/shared`, `src/main`,
`src/page/client/bridge.ts`, `tests/sync*`), editor agent (`src/page` except `database/` and `client/bridge.ts`),
database agent (`src/page/database`, `src/shared/database.ts`).

## Data model

Every document is a Yjs `Y.Doc`. A workspace has one tree document and one document per page.

- **Workspace tree** (doc id `ws`): `Y.Map` `pages`, keyed by page id (12 lowercase hex), each a `Y.Map`:
  `title` (string), `icon` (emoji or `file:<sha>`), `cover` (`file:<sha>`, `gradient:<n>` or empty), `parent` (page
  id, or empty for the workspace's top level), `order` (fractional index string), `kind` (`page` | `database`),
  `createdAt`, `createdBy`, `updatedAt`, `updatedBy`, `archivedAt` (0 when live), `deleted` (true once deleted for
  good), `props` (a `Y.Map` of property values when the parent is a database), `font` (`default` | `serif` | `mono`),
  `fullWidth`, `smallText`, `locked`. `Y.Map` `meta`: `name`, `icon`.
- **Page content** (doc id `p:<pageId>`): `Y.XmlFragment` `blocks` (BlockNote's collaboration fragment), `Y.Map`
  `comments` (threads), and for a database page `Y.Map` `schema` (properties) and `Y.Array` `views`
  (`src/shared/database.ts`).
- Per user and never shared: favorites, recent pages, sidebar expansion, last open page (`ardia.storage`).

Functions over these live in `src/shared/model.ts`; nothing else writes the maps directly.

## Storage and sync

A workspace lives in a folder. The private workspace is in the plugin's own files (`ardia.files`, root `data`,
folder `workspaces/<id>/`); a shared workspace is a folder the user granted (`ardia.folders`), normally in
`iCloud Drive › Ardia Shared › <name>`, shared with macOS Collaborate.

```
workspace.json               {"format":"ardia-notes","version":1,"id":"<ws id>","name":"…"[,"root":"<pageId>"]}  written once, exclusively; read at most 4 KB
docs/<doc>/<device>.snap     full Yjs state as that device last compacted it, or a pointer to its pieces (below)
docs/<doc>/.chunks-<device>/ the pieces of a snapshot over 4 MiB, named by their sha256
docs/<doc>/<device>.log      starts with the 8-byte header A5 4E 4C 48 44 52 00 02 (written in one atomic call), then
                             append only: each record is magic A5 4E 4C 52, a 4-byte big-endian length, a CRC-32,
                             then a Yjs update
files/<sha256>.<ext>         images and attachments, content addressed, written exclusively (pieces in files/.chunks)
presence/<device>.json       {"name","color","page","at"}: rewritten every 10 s while a page is open
presence/<device>.aw         {"at","docs":{"<doc>":"<base64 y-protocols awareness update>"}}: live cursors
```

**Never half a file.** A write of at most 4 MiB is atomic, so a `.snap` that fits is written in one call. A bigger one
is written as pieces of at most 4 MiB, each read back and checked, and then the `.snap` is replaced in one call by a
pointer (an 8-byte magic, then JSON with the size, the sha256 of the whole and of each piece); old pieces are removed
only after that. A reader follows the pointer and checks every hash, so it never takes half a snapshot as current. A log's
format comes from its header, never from its first record, so a torn first append can't make a reader misread it. An
append that fails is never retried blindly: the device asks the host for its log's size, and when anything reached the disk
it rewrites its snapshot and empties its log instead. A reader skips a record whose magic, length or CRC doesn't hold
and finds the next magic, so one torn record costs only itself. A log from before the framing is read the old way and
its own device rewrites it.

**Limits on what others write.** A shared folder is written by other people, so a device holds at most 64 MiB of one
document's files (all devices' snapshots and logs together, as they are now: a new snapshot replaces the old one's
count) and 384 MiB for a workspace, 64 devices per document, 4 KB of a presence file and 256 KB of a cursor
file, checking sizes before reading and reading logs 1 MiB at a time. A document over a limit is set aside (and
logged) and the rest of the workspace goes on.

`<doc>` is `ws` or `p-<pageId>`. Each device writes only its own files, so iCloud Drive never has two writers for one
file and never makes a conflict copy. A device reads everyone's: it watches the folder, reads a changed `.snap` whole
and a `.log` from the offset it last read (back to 0 and the `.snap` again when a log shrank), and applies the updates;
Yjs makes that idempotent and order free. When its own log passes 256 KB a device writes its `.snap` (everything it
has, others' changes included) and then empties its log. A crash between the two only repeats updates. iCloud
placeholders (`.<name>.icloud`) are asked to download and read once they arrive. Latency is iCloud Drive's: seconds,
sometimes a minute; two devices on one folder that syncs instantly (a test folder) converge at once.

**Edits the page couldn't send.** The page journals every Yjs update the moment it happens, one `localStorage`
entry per update under `ardia-notes-journal|<device>|<workspace>|<doc>|<load>|<seq>` (`<load>` is a random id per page
load), and sends them batched as `up {u, from, seq, load}`. Main appends every update it receives from a page to this
device's own log verbatim (even one Yjs is still holding for a missing dependency, or one it already has) and answers
`ack {from, seq, load}` exactly when that append is on disk; a failed append is retried and acked when the retry
lands. Durability never depends on Yjs clocks. The page clears only entries an ack names with its own `load`, so a
late ack from an earlier load can't clear a new edit, and it resends unacknowledged entries on a timer (5 s, doubling
to a minute) while it stays open. Compaction keeps updates Yjs still holds pending (`store.pendingStructs`,
`pendingDs`) in the snapshot; past 16 MB of such updates a doc stops acking new ones (the page keeps them) and says so.
Main holds an edit for a page whose metadata it hasn't seen yet for up to 10 s, then refuses it; an edit for a page
deleted for good (checked again right before applying) is refused with `outcome: "refused"`; an edit for a page that
moved to another workspace is applied there. A page edit to the workspace tree can't bring back a deleted page.
`deletePage` answers only once the tombstone is on disk, and edits for that page wait for it. On load a view resends
every entry this device left and deletes it only on its ack; this device's entries are never cleared for age before
they've been replayed; another device id's (a reset) are never replayed and are cleared after 7 days. A journal from
before this format is split into per-update entries first. The journal has a 4 MB budget; once an entry is written it
leaves memory. When nothing can keep an edit the page still sends it and reports `unsaved`, or `blocked` once its
in-memory copy passes 32 MB; `client.saveState()` / `onSaveState()` feed the save indicator, which never shows
"Saved" for a refusal and toasts refusals recorded before it mounted. The page never drops a message
`window.ardia.send` refuses: it keeps it queued and retries, and on `pagehide` it sends only what the page's limit
allows.

**Size limits are recomputed.** Every rescan rebuilds each remote device's charge from the files present now (snapshot,
its pieces and log) and keeps the workspace total under its cap (the largest documents are set aside first), so a
compaction or a deleted file can't leave stale charges, and a document set aside for size is taken back once its
files fit. This Mac's own files are never refused or skipped, and an existing log is only ever appended to (a new log
is created exclusively). A remote log is read again when its size or modification time changes.

**Sharing a private workspace.** A share, and a move of a page between workspaces, takes the locks of every workspace
it touches at once (in a fixed order) and waits for running edits, ops and uploads there to finish. Every attachment
and doc is copied, then the copy is opened in a fresh store and compared with the original byte for byte after both
are normalized (pending updates and deletions included) before the new record is saved; any difference rolls
everything back and the share fails. After the switch the reopened workspace is compared again, and the private copy
is removed only once it matches. A move writes the page into the destination and waits until that is on disk before
it tombstones the source (marking where the page went).

**Sharing one page.** The Share popover's first choice, "Share this page", shares a page and the pages inside it without
moving it out of a private workspace (`sharePage`, `src/main/notes.ts` `sharePageNow`). The page gets its own folder in
Ardia Shared (`ardia.folders.create`, then macOS Collaborate opens on it), laid out like any shared workspace; its
`workspace.json` adds `"root":"<pageId>"`, and its record keeps `root`, `home` (the private workspace it came from;
null for people who joined), `location` and `folder`. `WorkspaceInfo.pageShare` carries the same to the page. Sharing
takes the private workspace's lock, copies the attachments those pages reference (only theirs: the tree entries and
the docs' own content are scanned for `file:<sha>`), their tree entries and docs, waits until the copy is on disk,
reads it back in a fresh store and compares it before anything changes; then the private tree keeps the page's own
entry where it was, marked `sharedIn: <share id>` (a link), and tombstones the subpages with `movedTo`. There is one
copy to edit: the link holds no content. Edits addressed to the private copy (a view opened before the share) go to
the share (`target`), and `followShares` rewrites ops: a page made or moved under the link goes into the share (the
cross-workspace move path, which now also copies the moved pages' attachments), nothing lands beside the shared root,
and moving, trashing or deleting the shared root from the owner's tree acts on the link. A subtree holding a link
can't move to another workspace, nested shares are refused, and database rows and templates can't be shared alone.
Search, `resolve` and the tools skip links, so a page is found once, in its share.

The sidebar draws the link as the share's root row in place, with a small people mark; its subpages are the share's.
Page shares never appear in the workspace switcher or the Move dialog's top levels. Someone who joins one (Join shared
workspace…) sees it under **Shared with me**; the breadcrumbs say so, and they can edit, add subpages, invite and
leave, but not move or trash the shared root. For a shared page the popover shows where it's shared through
(iCloud Drive › Ardia Shared › folder), who is in it, **Invite people…** (Collaborate again), **Stop sharing**
(owner, confirmed inline) or **Leave**, and Copy link; the workspace move options stay below "Share this page" for
private pages.

**Stop sharing** (`stopSharingPage`, `stopSharingNow`) takes both locks, rescans and loads the whole share, and refuses
when someone's latest document files or any attachment the pages use are still iCloud placeholders (the share and its
grant stay, and the error says it's still downloading), when an attachment is missing from the folder, when part
of it was set aside for size, when the private copy of a page has anything the shared one lacks (the merged result is
compared before anything is applied), or when a page others added reuses the id of a live private page. It copies the
attachments, applies the shared state to the private docs, waits until they're on disk and reads them back in a fresh
store, then puts the tree entries back (the root where the link was, pages others added included, strays at the
share's top level under the root) and saves that before it forgets the folder grant. The folder itself stays, so the
people it was shared with keep their copy. A page view still sending to the old share id has its edits applied to the
private page. Leaving a page share you own, or deleting its link for good, removes the link and forgets the folder.

Counts (in `counts`, kept on the Mac like the tool counts): `page_share_creates`, `page_share_joins`,
`page_share_invites`, `page_share_stops`, `page_share_failures`. Tests: `tests/pageShare.test.mjs` (share, edits
through the private tree, a second device, stop sharing, subpage ownership, refusals, a hostile `workspace.json`) and
the `pageShare` page scenario in `tests/page/run.mjs`.

**Live cursors.** Page views on one Mac share awareness (cursor, selection, `user {name, color}`) through main. In a
shared workspace main also writes every local view's awareness for that workspace into its own `presence/<device>.aw`,
keyed by doc (`ws` or `p:<pageId>`): at most every 400 ms while it changes, then a keepalive every 6 s while any page is
open, and `{"docs":{}}` once the last one leaves. Other devices watch the file; on a change main diffs it against what it
last read and relays the new and changed clients (and removals for the ones gone) to its views subscribed to that doc,
and a view that subscribes later gets them at once. Each page keeps its own Yjs client id, so remote clients stay
distinct. A device whose file hasn't changed for 18 s (by the reader's clock, so clock skew doesn't matter) is dropped
and its cursors removed, so a device that quits without clearing its file (Ardia ends plugin hosts at quit) loses its
cursors within 30 s (keepalive, staleness and the 4.5 s sweep together); the page's own Awareness also drops a client that hasn't renewed in 30 s. Over a local folder
a cursor crosses in about 50 ms in the node test (two devices, Ardia's FSEvents watch adds its 150 ms coalescing);
over iCloud Drive it is iCloud's latency.

The device id is random and kept in `ardia.storage`; the user's name and colour come from the plugin's settings
rows.

## Addresses

`ardia://notes/` opens the last page (or the workspace's first). `ardia://notes/<slug>-<pageId>` opens a page (the slug
is the title, cut to 60 characters; only the id counts). `?v=<viewId>` picks a database view and `?p=<pageId>` opens a
row as a peek. `ardia://notes/search?q=…`, `ardia://notes/trash`, `ardia://notes/settings`. Moving between notes calls
`window.ardia.navigate(path)`, so each page is a history entry with its title.

## Search

main keeps a full-text index of every page's title and text (`src/main/search.ts`): words are folded (case,
diacritics), prefixes match, titles weigh most, recent edits break ties. The omnibox provider `notes` is `global`, so
every command bar query (the new tab's too) gets up to 5 notes with a snippet, opening `ardia://notes/<slug>-<id>`; the
`n` keyword (`n meeting`) asks only notes. The page's own search (⌘K / ⌘P in the app, and the sidebar's Search) uses
the same index.

## Wire protocol (page ⇄ main)

Over `window.ardia.send` (page → main, at most 64 KB a message) and `page.post` (main → page, at most 256 KB). Binary
is base64. Larger payloads are split: `{"t":"chunk","id","i","n","data"}` and joined before handling.
`src/shared/protocol.ts` has the types.

- page → main: `hello`, `sub {doc}`, `unsub {doc}`, `up {doc, u}`, `aw {doc, u}`, `viewing {workspace, page}` (the page the
  tab shows, which presence and `ardia://notes/` follow; docs a view only subscribes to, such as an inline database, don't
  count), `req {id, op, args}`.
- main → page: `ready {me, workspaces}`, `doc {doc, state}` (the full state, after `sub`), `up {doc, u}`, `aw {doc, u}`,
  `res {id, ok, value | error}`, `workspaces {list}`, `presence {list}`.
- `op`s: `createPage`, `duplicatePage`, `movePage`, `archivePage`, `restorePage`, `deletePage`, `search`, `resolve`
  (an address to a page), `upload` (chunked), `file` (bytes of a `file:<sha>`), `history` and `restoreVersion`,
  `createWorkspace`, `createSharedWorkspace`, `joinSharedWorkspace`, `shareWorkspace`, `sharePage`, `stopSharingPage`, `renameWorkspace`,
  `leaveWorkspace`, `openUrl`, `exportFile` (asks for a folder with `folders.pick`, writes the Markdown or HTML there
  under a free name, then forgets the grant; plugin pages can't download).
- Import: `importStart {workspace, source, pick? | uploadId?}`, `importStatus {job?}`, `importCancel {job}`,
  `importUpload {uploadId, i, name, data}` (base64 parts, for the CLI). Onboarding: `applyStarter`, `agentStatus`,
  `openArdiaSettings {pane}`, `agentDemo {workspace}`, `agentDemoStatus {job}`.

## Import

`src/main/import/`: the picked file (`ardia.files.pick`), folder (`ardia.folders.pick`) or uploaded export is opened as
one file tree; zips (nested too, unpacked to `import-spool/` in the plugin's files and removed after) and Joplin's tar
are expanded with entry, size, ratio, CRC and path checks. `sources/*` turn it into a plan of pages (Notion, Obsidian,
Logseq, Bear, Evernote, Apple Notes exports, Roam, Google Keep, Joplin, Simplenote, Craft, Markdown/HTML/text), and
`write.ts` writes them under a new top-level "<Source> import" page: BlockNote blocks straight into Yjs, page links as
mentions, files through `putFile` (deduplicated by sha256), CSV databases with typed properties. Main yields between
pages so the workspace stays responsive; a cancelled or failed import moves its root to the trash. An import reports
done only once every page it wrote is on disk (`flushDurable` of the docs it touched, within `durableTimeoutMs`);
otherwise it fails and keeps its recovery record. Quitting cancels a running import, waits for it (up to 10 s), keeps
the record, and the next start moves what it made (every root, records imports included) to the trash. Notion also imports
straight from the account (`sources/notionLive.ts`, the `NotionDetail` panel in `page/import/NotionSource.tsx`) by
reading the workspace's records, never through Notion's export (its export tasks only email a link, and its export API
is admin-only). When `ardia.sites.available()` says Ardia lends Notes the user's sign-in (only for Ardia's own official
plugins; otherwise the panel is the plain export-file flow) and the user is signed in to Notion in Ardia, every call
of a crawl runs in one `ardia.sites.session()` on the origin `getSpaces` answered from (`app.notion.com`, then
`www.notion.so`), which lists the account and its workspaces (guests and workspaces whose admins turned exporting off
can't be picked). Only read endpoints can be called: `notionReadUrl` refuses anything outside `NOTION_READ_ENDPOINTS`
(`getSpaces`, `syncRecordValuesMain`, `queryCollection`, `getSignedFileUrls`, `search`), and a test checks that no
write endpoint is even named in the file. The crawl seeds from `space.pages`, the space view's private, bookmarked
and shared pages, joined teamspaces' pages and one `search` of the space, then reads in rounds with
`syncRecordValuesMain` (100 records a call, halved while an answer is over the 768 KiB `sites.fetch` cap): every
`content` child, synced and linked blocks, page mentions, each collection and view, all rows (`queryCollection` from a
limit of 1000, ×4 while it says there's more, halved when too large, up to 10,000), and the users records mention. The
personal home page's system databases are left out. Files are then fetched one at a time with `ardia.sites.download`
into `notion-live/<run>/files/`: attachments and Notion's S3 files through `getSignedFileUrls` (signed onto
`file.notion.com`), built-in `/icons/` and `/images/` assets from the crawl's origin, and Unsplash covers from
`images.unsplash.com`. At most 4 requests run at once, paced under Ardia's 5 a second; 429 and 5xx wait for the longer of
a doubling backoff and `Retry-After`; 401/403 end the crawl with a sign-in reason; a 30-minute budget ends it with a
clear one. Cancel stops at once and removes what was fetched. The result is a `NotionRecords`
(`shared/notionRecords.ts`): `rootIds` are the sidebar's top-level pages in order, then pages whose parent wasn't
readable. `takeRecords()` hands it to the `pick: "account"` import once, and its `release()` removes the files. Ops:
`notionAccount`, `notionImport`, `notionImportStatus`, `notionImportCancel`. A crawl that couldn't read a collection's
rows to the end, or skipped records, lists them in `incomplete`, and each downloaded file carries the `version` of the
record that holds it.

**Importing Notion again.** A Notion page gets one id whatever the format: the zip id
(`notion-export:<workspace>:<32-hex id>`, `src/main/import/notionIds.ts`), and an older records id
(`notion:<workspace>:<dashed id>`) is recognised and kept, so a records import then a zip (or the reverse) updates one
page. A zip's first import gets a root id from its top pages, and a new page's body is written as a Yjs update from a
client id derived from the page and its exact content (`seedBody`), so two Macs importing the same export for the first
time merge into one root and one body. Each imported page keeps, in its tree entry's `imported` map, prints of what the
import last wrote: its body (`bodyPrint`, ignoring block ids, default attributes and trailing empty paragraphs), its
title, icon, cover and other page settings, its place, its trash state and each row property (`src/main/import/rebase.ts`).
On the next import a value the source didn't change is left as it is here; a source change applies when the value here
is still what was imported, and when both changed the local value stays and the page counts as a conflict
(`job.conflicts`, shown as "N pages kept your edits", counted as `<source>.conflicts` in `importStats`). A page whose
file fails to read is skipped and keeps its body. Pages from an earlier import that hold no prints yet count as a
conflict once if their body differs from the source, and keep theirs; their title and settings take the source, as before. Pages missing from an export are trashed only
when the result is complete: not past the 20,000-page limit, and for a crawl not in a collection whose rows stopped
early or under a record it skipped. Attachments are looked up by the path they resolve to, and a records file is
reused without reading only when its `version` matches the last import. Tests: `tests/review6.test.mjs`.

Tests: `tests/notionLive.test.mjs` (a fake
Notion host: pagination, 429, cancel, the budget, both origins, the read-only allowlist). Fixtures and tests:
`tests/fixtures/import`, `tests/import.test.mjs`.

## Platform extension points it uses

All public, documented in `docs/plugins.md`, usable by any plugin:

- `permissions.files` and `ardia.files` (read, write, append, list, remove, watch) over the plugin's own data folder.
- `permissions.folders` and `ardia.folders` (create in Ardia Shared, pick, list, share with macOS Collaborate,
  forget): folders the user grants, which `ardia.files` then reaches by the grant's id.
- A page panel with `"routes": true` serves every `ardia://<plugin>/<path>` from its one file and hands the page its
  path (`window.ardia.path`, the `navigate` event), and `window.ardia.navigate(path, {replace})` moves the tab within
  the plugin's addresses as real history entries titled by `document.title`.
- An omnibox provider may answer with the plugin's own `ardia://<plugin>/…` addresses.
- `permissions.sites` and `ardia.sites` (`app.notion.com`, `www.notion.so`, `file.notion.com`, `file.notion.so`) for
  one-click Notion import with the user's own Notion sign-in in Ardia ([Import](#import)).
- `ardia.files.pick` for an exported zip or file, and `ardia.app.controlStatus` / `ardia.app.openSettings` for the
  onboarding's agents step.

## Driving Notes from the `ardia` command

Everything in Notes is reachable as a tool (`contributes.tools`, `src/main/tools/`), so an agent can read and edit
pages, databases and the rest without the UI: `ardia plugins call notes <tool> '<json>'`, or `tools.call` from another
plugin. Each tool takes `{"action", …fields}`; `describe` returns every tool, action, field, block type, Markdown rule,
property type and setting, view setting, filter condition and formula function as data, so nothing needs these docs.
The agent-facing guide is `plugins/notes/AGENTS-CLI.md`.

| Tool | Actions |
| --- | --- |
| `describe` | everything, or one `topic` (a tool, `blocks`, `markdown`, `database`, `patchOps`) |
| `workspaces` | `list`, `create`, `create_shared`, `rename`, `share`, `leave` |
| `me`, `settings` | `get`, `set` (name, colour); `get` (row values, read only: Ardia owns them) |
| `pages` | `list`, `tree`, `get`, `create`, `update`, `move`, `duplicate`, `archive`, `restore`, `delete`, `open`, `backlinks`, `resolve` |
| `content` | `get` (Markdown, blocks with ids, text), `set` (merge or replace), `append`, `patch` (`insert`, `update`, `delete`, `move`, `replace`, `replace_text`, `children`) |
| `database` | `list`, `get`, `create` (full page or inline), `link` (linked view), `update` |
| `properties` | `list`, `add`, `update` (rename, retype, configure, options), `delete`, `move`, `duplicate`, `option_add`, `option_update`, `option_delete`, `option_move` |
| `views` | `list`, `get`, `add`, `update`, `delete`, `move`, `duplicate` |
| `rows` | `query`, `get`, `create`, `update`, `delete`, `restore`, `duplicate`, `move` (bulk where it says rows) |
| `comments` | `list`, `add` (page, block or quote), `reply`, `edit`, `resolve`, `unresolve`, `delete` |
| `history` | `list`, `get`, `restore` |
| `templates` | `list`, `create`, `apply` (page and database row templates) |
| `trash` | `list`, `restore`, `delete`, `empty` |
| `search`, `export` | the omnibox's index; a page or subtree as Markdown or HTML text |
| `files` | `upload` (base64), `get`, `list` |
| `import` | `markdown` (a page from text), `start` / `status` / `cancel` (another app's export through Ardia's picker) |

- **Same model as the UI.** Pages go through the page ops (`createPage`, `movePage`, …) and `shared/model.ts`;
  databases through `shared/database.ts`; comments in BlockNote's thread format. Content is converted in main, with no
  DOM: `tools/blocks.ts` maps BlockNote's Yjs XML (`blockGroup` › `blockContainer` › content node, marks as `XmlText`
  formatting, `columnList`/`column` as layout nodes) to BlockNote-shaped block JSON and back, and `tools/markdown.ts`
  maps that to a Markdown dialect (GFM plus `<details>` toggles, `> [!💡]` callouts, `::directives` for media, page and
  database blocks, `:::columns`, and a trailing `{#blockId key=value}` for ids and props). Tested both ways against
  the live editor: blocks written by the tool load in BlockNote unchanged, and every block the UI makes reads back equal.
- **Live and surgical.** Edits are Yjs transactions on main's copy of the doc, so open pages and other devices see them
  through the usual sync and keep their own edits. `content set` reconciles instead of rewriting: blocks are matched
  by `{#id}` or by content, unchanged ones keep their identity, and changed text is diffed so only the edited span is
  replaced. `patch` validates every op on a copy first, then applies them all in one transaction. A version is saved
  before a tool edits a page, as for the page's own edits, and locked pages refuse edits unless `force`.
- **Durable.** Each mutation answers after `flushDurable` with `saved: true` (false means written but not yet on disk).
- **Strict input.** Unknown fields, actions, block types, props, properties, options, views and pages are refused with
  the field's path and the nearest name (`unknown property 'Statu'; did you mean 'Status'?`); sizes are capped (5,000
  blocks and 100,000 characters a block per call, 200 rows created or 500 updated at once, ≤ 1 MB in and out).
- **Counts.** Each call is tallied per `tool.action`, with failures, in the plugin's storage (`toolCounts`, counts
  only), shown by `describe › usage`. Ardia's own `plugin_tool_calls` / `plugin_tool_failures` count them in telemetry;
  there is no extension point yet for a plugin to send its own counters, so these stay on the Mac.
- Tests: `tests/tools.test.mjs` (round trips, concurrent edits from a second Y.Doc, databases, validation,
  durability across a restart).
