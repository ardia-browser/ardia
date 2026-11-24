# Plugins

A plugin is a folder with a `plugin.json` that adds to Ardia without a restart. Plugin Architecture v2 (#3183) gives
it the same reach Raycast extensions have, inside a browser: native views written in JSX (lists, details, forms,
sidebar views, popovers), toolbar buttons, context-menu items, command bar entries and omnibox results, side panels,
themes, settings rows (secrets included, kept in the Keychain), decide hooks that can rewrite or stop a navigation,
tools the `ardia` command and other plugins can call, and commands it puts on your PATH. Issue #2462 began it;
programs and built-in plugins are #2568.

The rule behind the design: anything a first-party plugin needs becomes a public extension point here, never a private
hook. AI features ship as a plugin (#2463) through exactly these contributions.

Plugins run on macOS. Linux and Windows don't load them yet (`PLATFORM_FEATURES.plugins`): the Plugins pane says so,
and the `ardia` command's plugin commands still install and list files there.

## The shape of a v2 plugin

```
plugin.json          the manifest: what it adds, what it may touch, when it wakes
dist/index.js        main: the plugin's code, run by ArdiaPluginHost (JavaScriptCore, out of Ardia's process)
bin/helper           sidecar (optional): any program, for what JavaScript can't do
themes/dusk.json     themes it offers
page/index.html      a web page panel (optional), for a view JSX can't express
```

- **main** is a JavaScript file built against `@ardia/plugin-sdk`. Ardia runs it in `ArdiaPluginHost`, a small
  helper app holding one JavaScriptCore context, started inside the same `sandbox-exec` profile as any helper and
  always **offline**: it can't open a socket. Its only way out is Ardia's channel, and its `fetch` is Ardia's, limited
  to the hosts in `permissions.network` (below).
- **sidecar** is the v1 `process`: a long-running program of the plugin's own, with the same sandbox, supervision and
  channel ([The sidecar](#the-sidecar)). A plugin may have main, a sidecar, or neither (settings only), never both:
  a manifest that declares both is refused (`a plugin can declare main or sidecar, not both`).
- **Views are native.** A plugin never draws pixels: its JSX renders through the SDK's reconciler into a tree of plain
  nodes (`lib/pluginNodes.ts`), Ardia validates that tree and draws it with its own components, so a plugin's list
  looks, scrolls, themes and answers keys like Ardia's own.

## The SDK

`@ardia/plugin-sdk` (`packages/plugin-sdk`) is what main imports. It ships its own JSX runtime
(`@ardia/plugin-sdk/jsx-runtime`), a fiber reconciler and hooks, with no React dependency, so a bundle stays small.

```tsx
import { ardia, definePlugin, List, ActionPanel, Action, useState, useEffect } from "@ardia/plugin-sdk";

function Releases() {
  const [items, setItems] = useState<{ name: string; url: string }[] | null>(null);
  useEffect(() => {
    void ardia.net.fetch("https://api.github.com/repos/ardia-browser/plugins/releases").then((r) => setItems(r.json()));
  }, []);
  return (
    <List isLoading={!items} searchBarPlaceholder="Filter releases">
      {(items ?? []).map((r) => (
        <List.Item key={r.url} title={r.name} actions={<ActionPanel><Action.OpenInBrowser url={r.url} /><Action.CopyToClipboard content={r.url} /></ActionPanel>} />
      ))}
    </List>
  );
}

definePlugin({ views: { releases: Releases }, commands: { refresh: async () => ardia.ui.toast("Refreshed") } });
```

- **Components**: `List` (`List.Section`, `List.Item`), `Detail` (Markdown), `Markdown` (headings, lists, quotes, code fences, rules, bold, italic, inline code and http/https links), `Form` (`Form.TextField`,
  `Form.PasswordField`, `Form.Toggle`, `Form.Select`), `SidebarView` (`SidebarView.Section`, `SidebarView.Item`),
  `Popover`, `ActionPanel`, `Action` (`Action.OpenInBrowser`, `Action.CopyToClipboard`), `WebView` (one of the
  plugin's own files), and the small pieces `Box`, `Text`, `Badge`, `Button`, `Divider`, `EmptyState`, `Progress`.
- **Action shortcuts.** `shortcut` on an `Action`, `Action.OpenInBrowser` or `Action.CopyToClipboard` is `cmd` plus
  any of `ctrl`, `opt` (`option`, `alt`) and `shift`, joined by `+`, then one key: `a`–`z`, `0`–`9`, one of `` - = [ ]
  \ ; ' , . / ` ``, `space` or `f1`–`f12` (`"cmd+shift+e"`, `"cmd+k"`, or in glyphs `"⇧⌘E"`). `cmd` is Ctrl on Windows
  and Linux. Ardia drops a shortcut it can't read and one that would shadow a key it needs: no `cmd` (a plain or
  shifted key types into a field), `shift` with a digit or punctuation (a different character on each layout), any
  `cmd` shortcut on `q`, `w`, `t`, `n`, `h` or `m`, editing and system keys (`cmd+a`, `cmd+c`, `cmd+v`, `cmd+x`,
  `cmd+z`, `cmd+shift+z`, `cmd+shift+v`, `cmd+opt+shift+v`, `cmd+,`, `` cmd+` ``, `cmd+space`, `cmd+ctrl+space`,
  `cmd+opt+space`, `cmd+ctrl+f`, `cmd+ctrl+q`), and, at the moment of the press, any shortcut one of Ardia's own
  commands holds, which is most `cmd` letters (rebinding a command frees its key; Settings › Shortcuts lists them).
  Escape, Return, Tab, the arrows and Delete aren't keys a shortcut can use. The shortcuts that work are the active
  ones: in a `List`, the selected item's actions, then the list's own; in a `Detail` or `Form`, the actions it shows,
  ahead of any nested inside it; the first action in a panel wins a key two of them declare. A press runs the action
  exactly as a click does, and works while typing in the list's search field or a form field, and in a command view
  wherever its focus is. Action menus show each shortcut beside its action, and action buttons show it as their
  tooltip.
- **Hooks**: `useState`, `useReducer`, `useEffect`, `useLayoutEffect`, `useMemo`, `useCallback`, `useRef`,
  `useContext`, `useId`, and `useSurface` (which surface and window a view is in).
- **`ardia`**: `tabs`, `workspace`, `activePage`, `commands`, `tools`, `storage`, `secrets`, `net.fetch`, `programs`, `ui`
  (`toast`, `quickPick`, `inputBox`, `confirm`), `panels`, `toolbar` (title, badge, icon updates), `omnibox`, `decide` and `pages`.
  Each call is a request on the channel and is held to the manifest's permissions on Ardia's side; the SDK never
  decides what a plugin may do.
- **Rendering.** The reconciler batches a commit into one `surface.render` with the whole tree; Ardia checks it
  (node types, prop types, sizes, at most a few thousand nodes) and draws it. Events come back as
  `surface.event {handlerId, args}`, so a handler is a plain function in the plugin. A surface whose view throws shows
  the error in place, not a blank panel.

## Where they live

```
<config folder>/plugins/<name>/plugin.json     the manifest, and the plugin's own files beside it
<data dir>/plugins.json                         which plugins are on, what you approved, your row values
<data dir>/PluginData/<name>/                   the helper's home, temp folder and log
<data dir>/OfficialPlugins/<name>/<sha256>/     official plugins as fetched and verified on Install (below)
~/Library/Application Support/Ardia/Programs/   Ardia's copies of the programs plugins put on PATH (below)
```

- The config folder is `docs/config.md`'s (`~/.config/ardia/`, or `<data dir>/config` for a scratch instance), so a
  dotfiles repo can carry plugins. A plugin's folder may be a symlink (Ardia watches its target); its `plugin.json`
  may not: a linked manifest could point anywhere Ardia doesn't watch, so it is listed as a problem. Ardia reads
  regular files only, at most 1 MB per manifest, and at most 64 plugins.
- The folder name is the plugin's `name`. A folder whose name doesn't match its manifest is listed with that problem.
- Ardia watches the folder: a plugin appears, changes or disappears the moment its files do.
- Installing, enabling and the rest need no restart. Turning a plugin off withdraws everything it added at once.

### Official plugins: fetched on Install

First-party plugins (Command Line, `cli`, today) aren't packaged in the app. They're built and released in
github.com/ardia-browser/plugins. This repo pins each one's version and per-platform SHA-256 in
`apps/browser/official-plugins.json`, and the release copies that file, less unpublished artifacts, into Info.plist as
`ArdiaOfficialPlugins` (`export-sign.sh`, `official-plugins.py signed-pin`). The app's signature covers it, so the pin
is the only source of which version may be fetched.

- **Install** (Settings › Plugins, onboarding, or `plugins.enable` on the socket) fetches first, then asks. Native code
  (`OfficialPluginFetch.swift`, `PluginCore/OfficialInstaller.swift`) does the following:
  - downloads the pinned `macos-arm64` asset with an ephemeral `URLSession`: https only, at most 512 MB, idle timeout
    60 s, deadline 15 min. It goes into a private scratch folder under `OfficialPlugins/<name>/.fetch-*`.
  - refuses the download unless its SHA-256 is the pinned one.
  - unpacks it with its own gzip and tar reader. Only files and folders are accepted, all under `<name>/`: no links,
    devices, `..`, absolute paths, duplicates or PAX `size`/`linkpath` overrides. The caps (`OfficialArchive.Limits`):
    512 MB downloaded, 1 GB unpacked, 20,000 entries (files and folders, however they're named), 32 levels deep, and no more than 100 times the download's size
    unpacked overall or 200 times its compressed size for any one file. Neither ratio applies below 4 MB, so small text
    files that compress well are fine. Folders a path implies count as entries. zlib reads the one gzip member,
    checking its CRC and length; bytes after it (a second member, padding) are refused. The per-file ratio comes from
    how much of the stream zlib consumed while that file came out, taken every 4 KB of output. Verifying a kept copy
    applies the same caps. A file's ratio is checked before its staged file is created.
  - requires the unpacked `plugin.json` to be the pinned name and version, claiming only programs the pin reserves
    for it.
  - trusts nothing but the pin, as VS Code does with its own extensions: no Developer ID signature or notarization is
    required, so ad hoc and linker-signed programs run as published, and signed ones run too. The files are written by
    Ardia itself and carry no quarantine flag (one found on the download is cleared only after the SHA-256 matches),
    so Gatekeeper never asks to notarize them.
  - unpacks only after the SHA-256 matched, into a private folder (`.stage-*`, mode 0700) inside Ardia's data folder,
    then publishes it with a same-volume rename under a per-plugin lock as `OfficialPlugins/<name>/<sha256>/`, sealed
    read-only (folders 0555, files 0555 or 0444), and keeps the download beside it as `<sha256>.tar.gz` (0444). Program
    copies in `Programs/<name>/<version>/` are sealed the same way once they verify, except their top folder, where
    Ardia keeps its leases and after-update marks; removing either unseals it first.
- **What makes a copy official.** A copy counts only while its download still has a SHA-256 the signed app vouches
  for, and the payload digest of the copy (`PluginPrograms.payloadDigest`) equals the one computed by streaming that
  download's tar (`OfficialArchive.payloadDigest`, `OfficialVerification`).
  - The SHA-256s the app vouches for are the current pin's and those of earlier pinned artifacts listed in
    `apps/browser/official-plugins-history.json`, which `export-sign.sh` writes into Info.plist with the pin (each
    plugin's `trusted.artifacts`, `OfficialTrust`). `OfficialPlugins/<name>/active` only selects among copies that pass,
    and `plugins.json` plays no part in it: a copy no signed pin names is never official, whatever the record says.
  - `official-plugins.py history-check` fails when a `v*` tag that pinned a plugin still in the pin has no history entry,
    and the release-script tests run it, so a pin bump has to add the release it replaces.
  - Each lookup re-checks the stamps of the download and of every file in the copy, the digests are recomputed whenever
    one changed, and promotion always re-checks from scratch.
  - A replaced or damaged copy isn't listed as official, can't be promoted, and can't be linked. Linking stages the
    program copy and refuses it unless its digest is that same one.
- **Then consent.** That copy is a *candidate*: the scan lists it apart from the active plugins (`candidates` in the
  plugins store), and the consent sheet shows its manifest.
  - Its folder identity is `official-<sha256>`, so the approval hash binds the exact manifest to the exact artifact.
  - Confirming records the approval in `plugins.json`, then native code switches `OfficialPlugins/<name>/active` to
    that copy (`promoteOfficial`, which checks the hash against the copy again). The next scan lists it, and its
    programs link from it.
  - A crash after the record and before the switch is finished at the next scan, because the approval is on record.
  - A failed or offline download leaves no listing and no PATH change. The row says why ("Check your internet
    connection", "didn't match the copy this version of Ardia trusts", "programs aren't signed by Ardia") and offers
    Try Again, in Settings and in onboarding. Leaving onboarding during a download cancels it.
- **Updates.** A pin that names a new artifact fetches it in the background once you have the plugin, retrying after
  10 minutes, then doubling up to 6 hours.
  - It switches over by itself if its exact approval is on record: the same name and hash, or the old receipt below.
  - It also switches over by itself, with no sheet, when it grants nothing you hadn't already approved
    (`state/plugins/officialUpdate.ts`, #3868). All of these must hold:
    - the installed copy is official by native's say (the pin's digest, an earlier pinned digest, or a 0.2.47 bundled
      digest), it's on, and the record's `approved` is that copy's exact receipt;
    - the new copy is the verified download of the pin's own digest (`folderId` is the pin's), its manifest has the
      same `name`, is marked `official` and has no problems;
    - its manifest asks for nothing the approved one didn't. Every field that runs, reaches pages, changes the
      browser or grants anything must be identical, order and limits included: permissions (narrowing too, since it
      changes which other plugins may call its tools; only the order of network hosts doesn't count), programs with
      their paths and after-update steps, hooks, tools and their timeouts, settings defaults and rows, menus, toolbar,
      sidebar views, panels, omnibox, themes, site switches, the page bar, the page, `main` and sidecar specs with
      their memory budgets, every activation event other than `onCommand:`, and every approved command. A program's
      `example` must stay what Settings offers to copy (the pin's example stands in for a manifest without one).
      The one addition is a first `main` (the owner's call, for the move off the Python CLI): it passes only when
      its only way in is the command bar, with the new view or handler commands that reach it (all its activation
      events `onCommand:`; no page, panels, sidebar views, toolbar, omnibox, menus, tools, hooks or sidecar), and
      the unchanged permissions give it nothing to use (only `control`, the separate program-control setting). It
      is still a new runtime, able to show toasts and dialogs and relink its own programs, so the note says so.
      Python 0.4.0 to Bun 0.6.0 is this case. Title, description, version, `requires`, icon, keywords, the telemetry
      text and a program's `claim` don't count. Any field the comparison doesn't know, or a malformed one, prompts.
      The boundary row is `plugin-update:official-auto`.
    - The record keeps `previous` for a rollback and an `updated` note (`from`, `to`, the consent lines that are
      new, and `runtime` when it added a first `main`). While that copy is the one installed, the plugin's page shows
      "Updated by itself to 0.6.0", "It added its own code, which runs in Ardia's sandbox, offline, and first starts
      when you use one of its commands in the command bar" when it did, "Its permissions didn't change", and those lines.
      `official_updates_auto` counts the switch once it took.
      Approving any later update by hand drops the note.
  - Otherwise it waits, and the plugin's row offers **Update…**, which shows the consent sheet for the new copy. It
    also waits while the consent sheet is open for that plugin, and when nothing is on record: an `ardia` installed
    the old way that was never approved isn't adopted, since there's no approval to compare with.
  - Telemetry: `official_updates_auto` counts updates that installed by themselves; `official_updates_waiting` the
    ones left for review, with `official_update_prompts_<reason>` saying why (`baseline`, `permissions`, `network`,
    `runtime`, `activation`, `programs`, `hooks`, `settings`, `contributions`, `unknown`), once per download.
  - Until then the approved copy keeps running, and `previous` in the record keeps it approved while the switch
    happens.
- **Provenance.** Only native code decides that a plugin is official: the signed pin plus a verified copy in the
  store, or an earlier copy as described below. `PluginFolders.list` marks those entries `official`. A folder you add
  to `plugins/` named `cli` gets no official privileges, and `appChecks` refuses its `official`, `alwaysOn`,
  `autoInstall`, `claim` and `afterUpdate`. `afterUpdate` runs only for a fetched official copy.
- **Same switch and Remove as any plugin.** An official plugin has an on/off switch and Remove on its page.
  - Off unlinks its programs. On relinks them with no new consent while its approval matches.
  - Remove deletes its download and its PATH link and program copy, and keeps `PluginData/<name>` and its secrets, so
    installing it again picks up where it left off.
  - `"alwaysOn"` now only keeps `installed: true` in the record, so 0.2.47 sees the same install after a rollback.
  - `"autoInstall"` activates nothing: activation always needs the user's approval.
  - "Let programs control Ardia" in Settings › Advanced still governs control on its own.
- **0.2.47 installs.** 0.2.47 bundled Command Line 0.4.0, approved as `sha256(manifest + "\0bundled")` and copied to
  `Programs/cli/<version>` with `ardia` linked to `Programs/cli/current/bin/ardia`.
  - Until a fetched copy is active, the scan lists that copy as the plugin (folder identity `bundled`, `legacy`), but
    only while its payload digest is the one a release shipped (`trusted.bundledDigests`, one per release, since each
    re-signed its bundled copy) and the record's old receipt approves it exactly. The history covers every release that
    bundled Command Line: 0.2.47-nightly.7 (0.3.0), 0.2.47-nightly.8, 0.2.47-nightly.9 and 0.2.47 (0.4.0). A copy from
    anywhere else stops counting as official: its `ardia` is taken off PATH and Install… is offered. Its programs are kept linked in place
    (`PluginPrograms.keepLegacy`), with nothing restaged or switched.
  - The launch sweep keeps every installed official plugin's link, listing or not (`programsKeptAtLaunch`).
  - The fetched replacement switches over silently when its `plugin.json` is the one already approved (it carries
    `legacyHash`, the old receipt of its own manifest); otherwise it waits for review as above.
  - The silent switch records the exact approval of the download and keeps the 0.2.47 receipt as `previous`, so a
    later pin change keeps it approved and 0.2.47, which only checks `installed` for its Command Line, still runs its own
    copy after a rollback.
- **Publish before switching.** `PluginPrograms.install` stages, verifies the payload digest and the team signature,
  then checks that every program can go on PATH before it moves `current`. A replacement that can't take over (a name
  someone else holds) leaves the old target in place and reports the refusal (`kept`). A retry finishes the switch.
- **Test instances** read the pin from `ARDIA_TEST officialPin=<official-plugins.json>`. Any scratch instance, Release
  included, may fetch from a folder instead of GitHub with `ARDIA_INSTANCE officialPluginsFrom=<dir>`; the SHA-256 and
  signature checks are unchanged.

### Official plugins: the seam for Settings and onboarding

`apps/browser/src/state/plugins/actions.ts` (and `hooks.ts` for the hook) is the stable API the official-plugins UI
builds on; `programs.test.mjs` and `adoption.test.mjs` pin it.

- `useOfficialPlugins(): OfficialPlugin[]`, a hook, and `officialPlugins(store, supported?, showComingSoon?)`, its pure
  form. `OfficialPlugin` is `{ name, title, blurb, icon, version, example, switchable, state }` (`switchable`: built in but not always on, so it has an off switch; `example`: the first `programs[].example` its manifest gives), `state` one of `"available"`, `"installed"`,
  `"comingSoon"`, `"unsupported"`. The list is `OFFICIAL_CATALOGUE`, built from `apps/browser/official-plugins.json`
  (`state/plugins/officialPin.ts`: each pinned plugin's `name`, `title`, `blurb` and `icon`), plus
  any other built-in plugin whose manifest says `official`; title, blurb and icon come from the bundled manifest when
  there is one. Only a built-in plugin can claim `official`, so a plugin you install never shows here. Where plugins
  aren't supported (Linux and Windows today, `PLATFORM_FEATURES.plugins`), or the app has no bundled copy, every entry
  is `"unsupported"`; Linux's own `ardia` installer (Settings › Advanced) is unchanged.
- `COMING_SOON` entries (the pin's `comingSoon`, the AI plugin today) show as `"comingSoon"` only while their
  experiment is on (`officialPluginsAi`, off by default), and never install.
- The pin also says which plugins onboarding ticks (`"preselected": true`, `PRESELECTED_PLUGINS`) and which old Settings
  anchors still lead to a plugin's row (`"anchorAliases": ["commandLine"]` resolves `plugins.commandLine` to
  `plugins.cli`). `scripts/release/official-plugins.py check` validates every field.
- `installOfficialPlugin(name, { showSheet? }): Promise<{ ok: boolean; reason?: string }>` opens the consent sheet (in
  Settings › Plugins on that plugin, unless `showSheet: false` and the caller shows `PluginConsentSheet` itself) and
  settles when it's decided, as `InstallResult = { ok: true } | { ok: false; reason: string; cancelled?: true }`:
  `{ ok: true }` once installed and its commands are on PATH; `{ ok: false, cancelled: true, reason: "Cancelled." }`
  when the user closed the sheet (Cancel, or the Settings window it was in); `{ ok: false, reason }` with no
  `cancelled` when another install or another plugin's sheet takes its place, when it can't load, or when it
  installed but its commands couldn't be linked (asking again retries the link and needs no new approval). Show
  `reason`, and treat `cancelled` as no error. A replaced sheet
  can neither approve nor cancel the newer one, and an old install adopted while the sheet is open closes it with
  `{ ok: true }`.
- `PluginConsentSheet({ name, hash, onClosed })` (`components/plugins/PluginConsentSheet.tsx`) is the sheet itself, and
  `usePluginConsent()` says which plugin's sheet is open.

### Official plugins: where they're offered

Both surfaces read the seam above and nothing else; `state/plugins/officialView.ts` maps a plugin's state, its link
state and the attempt in progress to what a row shows (`officialView.test.mjs`).

- **Settings › Plugins › Official** (`components/settings/panes/OfficialPlugins.tsx`), above the other plugins, which no
  longer list an official one twice. Text is kept to a minimum: a heading, and per row the icon, the seam's title and
  its blurb on one line. **Install…** (**Turn On…** for a switchable plugin, matching its sheet) opens the consent sheet in place and the row turns to installed with no reload; a switchable plugin that's on reads "On" beside its title, with a switch that turns it off;
  installed reads "Installed · <version>" beside the title, with its manifest's first `programs[].example` in mono and **Copy** (where the
  command lives is on the plugin's own page, behind the chevron); a failure shows its reason with **Try Again**;
  coming soon is the title and "Coming soon"; unsupported shows nothing. The list below has one short line, and its
  empty state is "None yet" with **How to add one**, which shows the folder and the `ardia plugins install` hint.
  Every pinned or coming-soon plugin has its own generated row, `plugins.<name>`, which Settings search finds by its
  title, its blurb and the bundled manifest's `keywords`; "Official plugins" finds the section.
- **Onboarding** has a step between Make it home and the outro (`components/onboarding/PluginsStep.tsx`,
  `state/onboarding/pluginsStep.ts`). The command line starts ticked. **Install** shows the same consent lines inside
  onboarding (`consentLines`, with the same changed-while-open guard) and nothing is installed until **Install** there
  is pressed; **Cancel** returns to the offer; **Skip** installs nothing. A failure shows its reason and never blocks
  Continue. When everything is already installed the step says so, and when nothing can be offered (Linux, Windows,
  the web demo, a build with no bundled copy) the step is left out.
- **Counts** (`state/telemetry/officialPluginCounts.ts`, in the hourly `usage_counts`):
  `official_plugin_<onboarding|settings>_<shown|installed|skipped|failed>_<name>`, where `<name>` is any pinned or
  coming-soon plugin's name with `-` as `_` (so `_cli` and `_ai` stay as they were) and `other` for anything else. `shown` counts a plugin that
  could still be chosen, `skipped` is onboarding only, and a closed consent counts as nothing. Watch
  `…_onboarding_installed_cli` against `…_onboarding_shown_cli` for the take-up, and `…_failed_cli` for a regression.
- On the control socket, `plugins.official` returns the same list; `plugins.enable` on an official plugin opens its
  sheet and answers `{"waiting": true}`.


## The manifest

```json
{
  "$schema": "../../plugin.schema.json",
  "manifest": 2,
  "name": "example",
  "title": "Example",
  "description": "One line on what it does.",
  "version": "2.0.0",
  "requires": "0.2.50",
  "icon": "sparkles",
  "main": "dist/index.js",
  "memoryMB": 128,
  "activationEvents": ["onUrl:github.com"],
  "permissions": { "tabs": "read", "activePage": true, "storage": true, "secrets": true, "network": ["api.github.com"] },
  "contributes": {
    "commands": [
      { "name": "releases", "title": "Show Releases", "icon": "shippingbox", "view": "releases" },
      { "name": "refresh", "title": "Refresh Releases" },
      { "name": "beside", "title": "Open Example Beside This Tab", "open": "split", "context": true, "sideSetting": "side" }
    ],
    "menus": { "tab": [{ "command": "refresh", "when": "urlHost ~= '*.github.com'" }] },
    "toolbar": [{ "id": "status", "title": "Example", "icon": "sparkles", "view": "status" }],
    "sidebarViews": [{ "id": "feed", "title": "Feed", "icon": "list.bullet" }],
    "panels": [
      { "id": "chat", "title": "Chat", "icon": "bubble.left", "mode": "sidecar", "view": "chat", "retainContext": true },
      { "id": "default", "title": "Example", "icon": "sparkles", "mode": "tab", "file": "page/index.html" }
    ],
    "omnibox": [{ "id": "gh", "title": "GitHub", "keyword": "gh" }],
    "themes": [{ "id": "dusk", "title": "Dusk", "file": "themes/dusk.json" }],
    "hooks": ["tab.activated", "tab.opening"],
    "settings": {
      "defaults": { "commandBarStart": { "openTabs": { "limit": 5 } } },
      "rows": [
        { "key": "token", "title": "GitHub Token", "type": "secret", "placeholder": "ghp_…" },
        { "key": "limit", "title": "Releases Shown", "type": "number", "default": 10, "min": 1, "max": 50, "step": 1 },
        { "key": "side", "title": "Open Beside On", "type": "choice", "default": "right", "choices": [{ "value": "left", "title": "Left" }, { "value": "right", "title": "Right" }] }
      ]
    },
    "tools": [{ "name": "hello", "title": "Say hello", "description": "Greets someone.", "timeout": 10 }],
    "programs": [{ "name": "example-tool", "path": "bin/example-tool" }]
  }
}
```

- `manifest` is the schema version, now 2. A newer version than Ardia knows is listed as "needs a newer Ardia" and
  never loads. Unknown keys anywhere are errors, so a typo never silently does nothing. Every problem is reported at
  once, with its path (`plugin.json: contributes.commands[0].tool: hello isn't one of this plugin's tools`); a
  manifest with any problem doesn't load, the Plugins pane shows the problems and `ardia plugins check` prints them.
- `name`: 1 to 40 lowercase letters, digits and dashes, starting with a letter or digit, and the plugin's folder
  name. `title` up to 60 characters, `description` up to 200, with control and bidi characters refused. `version` and
  `requires` are `MAJOR.MINOR.PATCH` with an optional `-suffix`; a plugin that requires a newer Ardia doesn't load.
  `icon` is an SF Symbol.
- `main` is a `.js`, `.mjs` or `.cjs` file inside the plugin's folder; `memoryMB` (only with `main`) is the host's
  watchdog threshold. `sidecar` is `{run, memoryMB}` as below. A command with no action of its own (`tool`, `open`,
  `view`, `panel`) is handled by main, so it needs one.
- `keywords` (v2): up to 12 words of up to 40 characters that find the plugin's row in Settings search.
- `telemetry` (v2): `{ "title": "…", "items": ["…"] }` (1 to 16 items of up to 800 characters), what the plugin's own
  programs collect. Settings › Privacy › What's Sent shows it under its title for every installed plugin that has one,
  labelled as the plugin's own, under its own heading, "From plugins you added" ("What each plugin says its own programs
  send. Ardia doesn't send it, and the switch above doesn't control it"). An official plugin whose pinned release has no block yet uses the pin's
  `telemetry` (the command line's "The ardia command" today), labelled as described by a plugin that ships with Ardia;
  that block also shows while an old standalone install of it is still in place, asked again each time What's Sent
  opens. The pin's `example` is likewise the
  first command shown until the plugin's manifest gives one. Ardia's own counters
  about what a plugin does (the `cli_socket_*` and control-pill counts, for one) stay in Ardia's own copy.
- The app writes `plugin.schema.json` beside `config.schema.json` (`docs/config.md` › Schemas), generated from the
  same rules, for editors and the CLI. The app validates with its own code.

### Migrations: 0 → 1 → 2

Old manifests keep working with no edit, through `MANIFEST_MIGRATIONS` in `lib/pluginMigrations.ts`, like every saved
document (`docs/conventions.md`):

- **0 → 1.** A file with no `manifest` is version 0, the settings-only presets of github.com/ardia-browser/plugins
  (`name`, `title`, `description`, `requires`, `settings`, `reset`): its `settings` becomes `settings.defaults`, and
  `reset` (the old installer's) is dropped.
- **1 → 2.** `commands`, `tools`, `hooks`, `settings`, `programs` and `passwordManager` move into `contributes`;
  `page` becomes the panel `{"id": "default", "mode": "tab", …}`; `process` becomes `sidecar`; and the permission
  list becomes the object (`"tabs"` → `"tabs": "read"`, `"network"` → `"network": "*"`, any other name → `true`).
  A manifest that already has `contributes`, `main` or `sidecar` is taken as v2 whatever its number says.
- Problems in a migrated manifest are reported in its own words (`v1Problem`): a v1 plugin hears about `page` and
  `process`, not `contributes.panels[0]` and `sidecar`.
- The approval is the hash of the file's text, so a migration never asks for a new approval. Command Line 0.4.0, the
  copy 0.2.47 bundled and that a 0.2.47 install keeps until its replacement is approved, is a v1 manifest and loads
  through this path unchanged; `keywords`, `telemetry`,
  `programs[].example` and `programs[].claim` need manifest 2.

### activationEvents

When main starts. Without the key Ardia derives the list from the contributions (`derivedActivationEvents`):
`onCommand:<name>` for each command, `onView:<id>` for each sidebar view, `onPanel:<id>` for each view panel,
`onToolbar:<id>`, `onOmnibox:<id>`, `onMenu:<slot>` for each menu slot used, and `onStartupFinished` when the plugin
has hooks (or only a sidecar). Given explicitly, each entry is `*` or `onStartupFinished` (at launch), one of those
prefixes, `onEvent:<event>` or `onUrl:<host pattern>` (when a tab in a normal window goes to a matching host). A
plugin that isn't needed yet costs nothing: no host process, no memory. The first use waits for it to start
(`ensurePluginActivated`, a few hundred ms cold) and a failure says why (`PluginActivationError`).

### permissions

| Key | Values | What it allows |
| --- | --- | --- |
| `tabs` | `read`, `write`, `false` | `read`: list windows and tabs, subscribe to tab, window and page events, URLs without their query and fragment. `write`: also open, move and close tabs, and `apply` with only `open` (no `group` or `profile`), `tab.close` and `tab.activate`; its answer's URLs are cut the same way unless `fullUrls` |
| `fullUrls` | `true` | Those URLs in full (needs `tabs`) |
| `activePage` | `true` | Read the text and selection of the page you're on when you run one of its commands (`plugin_page_reads`). The read is refused once you switch tabs or the page navigates after that use |
| `workspace` | `true` | See and arrange every tab, group and folder (needs `tabs: write` and `fullUrls`) |
| `commands` | `true` | Run Ardia's commands, the same ones with the same refusals as the `ardia` command (`docs/automation.md` › Which commands) |
| `storage` | `true` | A private key-value store in `PluginData/<name>/storage.json`, at most 2 MB in all and 256 KB a value (`plugin_storage_writes`). `storage.get` answers `{found: true, value}` or `{found: false}`. A file Ardia can't read or parse, an empty one included, fails every call; Ardia never overwrites it with an empty store |
| `secrets` | `true` | Keychain items of its own (`ardia.plugin.<name>.<key>`, at most 64, 16 KB each; `plugin_secret_writes`). If the Keychain's list of them can't be read, Ardia keeps it, fails secret writes and deletes, and says removing the plugin left its secrets |
| `network` | `false`, `"*"`, or 1 to 32 host patterns | main's `fetch` reaches only these hosts (`*.example.com` included); a sidecar gets the network as in v1. A web view the plugin shows (its page, a `file` panel) goes online only with `"*"`: WebKit's traffic can't be held to a list of hosts, so with a list it stays offline and the plugin reaches its hosts through `net.fetch` |
| `control` | `true` | Turning it on turns on `cliControl`, unless you turned control off yourself: an Off you chose wins, and the consent sheet points to the switch, Settings › Advanced › Let programs control Ardia. While control is on, any program you run has the `ardia` command's reach: the control socket and the engine's token connection, a full DevTools client of the browser (every tab and page, signed-in sites and their cookies, downloads and uploads; `docs/cli.md`). So the consent sheet and the plugin's page in Settings › Plugins put that first ("Turns on control in Settings › Advanced. While it's on, any program you run can fully control Ardia: every tab and page, your signed-in sites and their cookies, and uploads and downloads of any file on this Mac"; "While control is on …" when you turned control off yourself, and naming the commands Ardia runs for it after updates when it has any), and its row in the list, the official ones' included (also while an update has failed), says "Can fully control Ardia" (`fullControlLine`, `FULL_CONTROL_SUMMARY` in `state/plugins/consent.ts`) |

The old list form (`["tabs", "network"]`) still reads, as above. Contributions grant their own reach and are shown on
the consent sheet too: a toolbar button, a sidebar view, a context-menu item, a theme, a decide hook, site switches in
Site Controls and a page bar with the actions it names.

### settings

- `defaults` sets Ardia settings while the plugin is on. Only settings `config.json` may set are accepted (the config
  allowlist, `docs/config.md`), with the same checks, so a plugin can't turn on CLI control, add a search destination
  or change which engine shows a site. When you turn the plugin on, each default that `config.json` doesn't set is
  applied through `updateSettings` and the value it replaced is remembered; turning the plugin off puts that value back
  unless you changed the setting since or `config.json` now sets it. When two plugins set the same setting, turning
  either off leaves the other's value or, once both are off, the one from before either. `config.json` always wins.
  `omniboxProviders` and `launchActions` have approvals of their own (`docs/automation.md` › Approvals), so a plugin
  can't set them.
- `rows` (at most 20) add rows to the plugin's page in Settings › Plugins: `toggle` (boolean), `text` (up to 200
  characters), `number` (with optional `min`, `max` and `step`; `default` between them), `choice` (2 to 12 `choices`,
  `default` one of their values) and `secret`. `key` is 1 to 40 letters, digits, `-` and `_`; `description` is an
  optional second line. Values are kept in `plugins.json` and sent to main and the sidecar; nothing in Ardia reads them.
- A **`secret`** row is a password field whose value never touches `plugins.json`, logs or telemetry: it is a Keychain
  item (`ardia.plugin.<name>.<key>`, `state/plugins/secrets.ts`), the row shows only whether it is set, and main reads
  it with `ardia.secrets.get(key)` (needs `secrets`). Removing the plugin deletes its items.

### commands

At most 20. Each adds a command bar entry titled `title` (up to 60 characters), found by its title, `keywords` (up to
8) and the plugin's title, drawn with `icon` (an SF Symbol, default `puzzlepiece`), with an optional `when` clause
(below). Plugin commands have no keyboard shortcut of their own; a manifest with `shortcut` is refused. A command does
one thing:

- `"view": "<id>"` shows one of main's views in the command bar, as Raycast does.
- `"panel": "<id>"` opens one of its panels.
- `"tool": "<name>"` calls one of the plugin's tools with `input`. A result with a `message` shows as a toast.
- `"open": "tab"` or `"open": "split"` opens the page panel, as in v1: `side`, `sideSetting`, `context` (needs `tabs`)
  and `path` work as they did.
- nothing of the above: main handles it (`definePlugin({ commands: { <name>: fn } })`).

Plugin commands aren't offered in private windows, and nothing a plugin gets ever names a private tab or a Peek: the
same tabs hooks and the `ardia` command never see (`docs/automation.md`).

**`when` clauses** (`lib/pluginWhen.ts`) decide where a command, menu item shows: `&&`, `||`, `!`, `==`, `!=` and
`~=` (a glob) over `urlHost`, `urlScheme`, `isPinned`, `isInGroup`, `isSplit`, `isActive` and
`tabCount`. In the command bar the clause is checked against the window's current tab, and a command whose clause
doesn't hold isn't offered. A clause is checked again when the item runs, so a stale menu or command bar never runs a
command where it doesn't belong.

### menus

`contributes.menus.<slot>`, with slots `tab` (a tab's context menu) and `group` (a group's or folder's): each entry
names one of the plugin's commands, with an optional `title`, `icon` and `when`. They show as a section above Close in
that context menu (`state/plugins/menus.ts`); more than 2 from one plugin fold into a submenu named after it. Never in a
private window's or an incognito group's menus. Running one from a tab hands the command `{from: "menu", slot: "tab",
url, title, tabId, windowId}`, with the URL cut to the plugin's permissions; from a group, `{from: "menu", slot:
"group", groupId, title, tabCount, windowId}`, with `when` checked against the group's shown tab (`plugin_menu_runs`).

### toolbar

`contributes.toolbar`: buttons beside the extensions in the toolbar (and in the sidebar's address field), each with an
`id`, `title`, `icon`, optional `tooltip`, and either a `command` or a `view` that opens as a popover anchored to the
button. main can update a button's title, icon and badge live (`ardia.toolbar.update`). The URL field gives them room,
so nothing overlaps (`plugin_toolbar_runs`).

### sidebarViews

`contributes.sidebarViews`: a native section in the sidebar under the tab list, drawn from main's `SidebarView`
tree (`SidebarView.Section`, `SidebarView.Item`). Never in a private or incognito profile's sidebar.

### panels

`contributes.panels`, each with an `id`, `title`, `icon`, a `mode` and either a `view` (native) or a `file` (a web page
from the plugin's folder):

- `sidecar`: a panel beside the page on the window's right, like Arc's and Dia's sidebars. `retainContext: true` keeps
  it mounted, state and scroll included, when it is hidden, so a chat survives switching away (`plugin_panel_opens`).
  Closing a window drops its panels.
- `tab` and `split`: the page tab at `ardia://<name>` ([The page](#the-page)); `side` goes with `split`.

A popover is a toolbar button's `view`, not a panel mode. Panels, popovers, command views and the surfaces in them
never open in a private window.

### omnibox

`contributes.omnibox`: result providers for the command bar. With a `keyword` (`gh`), typing it then a space hands the
rest of the query to main; with `global: true` main is asked for every query, within the omnibox's deadline. A
provider has one or the other, not both. Queries in private windows never reach a plugin (`plugin_omnibox_queries`).

### themes

`contributes.themes`: theme files in the format of `docs/config.md` › Themes, listed by `pluginThemes()` with the
plugin's title, and picked in `config.json` as `"theme": "plugin:<plugin>/<id>"`. The file is read through the
approved folder like a page's files, so a changed plugin stops its theme until it is approved again; turning the plugin
off returns to Ardia's own colours, and the problem shows in the config toast.

### hooks

Events from Ardia's automation event table (`docs/automation.md` › Events) delivered to main (`ardia.on`) or the
sidecar (`subscribe`). Every event is listed here, so it shows on the consent sheet. Events about windows, tabs, pages,
media, Peek, pins, splits and profiles need `tabs`.

**Decide hooks.** `tab.opening`, `link.opening` and `permission.requested` (with `tabs`) let a plugin answer before
Ardia acts: `{cancel: true}` or `{url}` for an opening, `{drop: true}` or `{profile, open}` for a link from another
app, `{permission: "deny"}` for a permission prompt. The rules:

- Ardia's own `hooks.json` decide hooks and Air Traffic rules come first; a plugin is asked only when they leave the
  decision open.
- Never for a private window, an incognito profile or a Peek.
- Only plugins already running are asked: a decide hook never starts one. Each has at most 250 ms (less when the
  event's own deadline is shorter); one that doesn't answer in time counts as no answer
  (`plugin_decide_timeouts`) and the navigation goes on.
- When more than one plugin answers, the first in plugin order wins.
- URLs are cut to the plugin's permissions, as everywhere.

### tools

At most 32. A tool is an action main or the sidecar performs on request: `name`, `title`, `description` (up to 200
characters), `timeout` in seconds (1 to 300, default 30). Callers: the plugin's own commands, the `ardia` command
(`ardia plugins call`), and other plugins (`tools.call`). Input and result are JSON, at most 1 MB.

### sidecar

```json
"sidecar": { "run": ["/usr/bin/python3", "helper.py"], "memoryMB": 256 }
```

`run` is the sidecar's argv: its first item is a file in the plugin's folder (`bin/helper`), an absolute path
(`/usr/bin/python3`), or a bare name found on `/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin`.
At most 32 items, each up to 1,024 bytes, no NUL. `memoryMB` (64 to 4,096, default 1,024) is a watchdog
threshold, not a hard cap. See [The sidecar](#the-sidecar).
What the approval pins is the plugin's root folder, not the files in it. A program in the plugin's folder is checked
through the approved, opened folder (one path component at a time, no links, an executable file) and started as
`./bin/helper` with that opened folder as its working directory, so a folder swapped in for the approved one never
runs. The program file itself is looked up again by that path when it starts: whoever can change files inside the
approved folder can change what runs between the check and the start, as they can change the code at any time; the
approval covers the manifest's declarations, not the code. An absolute path or a bare name is outside the plugin:
it is whatever is at that path when the helper starts. The approval names it ("Runs a program in the background:
/usr/bin/python3 helper.py"), it may not live in Ardia's data or config folder, and beyond that it is trusted as
installed, like a hook's program in `hooks.json`.

### The sandbox

Every helper starts under `/usr/bin/sandbox-exec` with a Seatbelt profile built by `PluginCore/PluginSandbox.swift`,
and so does main's `ArdiaPluginHost`. The profile starts from `(deny default)` and allows only what is listed below.
Paths go in as `-D` parameters, never into the profile's text.

- **Everyone:** reading and mapping the system (`/System`, less `/System/Volumes` except dyld's cryptexes, `/usr/lib`,
  `/usr/share`, `/Library/Apple`, the time zone database), metadata (`stat`) outside the protected folders below,
  `/dev/null`, `/dev/zero`, `/dev/random`, `/dev/urandom` and `/dev/fd`, reading the plugin's own folder and program,
  reading and writing `PluginData/<name>/`, descriptor 3 (the channel), `sysctl` reads, the Mach services on
  `machAllowed`, the global preferences domain, and inspecting or signalling only its own processes.
- **A sidecar** may also fork and start programs: those in its own folder, the tools in `/bin`, `/sbin`, `/usr/bin`,
  `/usr/sbin`, `/usr/libexec`, the `bin`, `sbin`, `lib`, `libexec`, `opt`, `Cellar`, `Frameworks` and `share` folders of
  `/usr/local` and `/opt/homebrew` (nothing else there, so no `etc`, `var` or a database beside them), the Command Line Tools and
  the Xcode `xcode-select` points to, so `/usr/bin/python3` and `git` work. It reads those trees, `/etc/ssl` and a few
  files programs look up (`passwd`, `group`, `services`, `localtime`, Xcode's license choice). An absolute program also
  reads its own install folder (`/opt/homebrew/opt/node` for its `bin/node`), except in a shared temp folder or straight
  in `/usr`, `/usr/local` or `/opt/homebrew` (`/usr/bin/python3`, `/opt/homebrew/bin/brew`), where it reads only itself.
- **main's host** may start nothing, not even a file in its own folder, and can't fork. It reads only the system, its own
  binary and the plugin's folder.
- **With network** (a sidecar whose plugin is granted it), outbound and local IP, the resolver's socket, the
  `machAllowedOnline` services and `/etc/hosts` and `resolv.conf`. Without it, no IP at all: no loopback, no listening,
  no names. main's host is always offline.
- **An official plugin's folder** is its verified, read-only copy, `OfficialPlugins/<name>/<sha256>/`, the one place in
  Ardia's data folder a plugin may run from: only the copy `OfficialTrust` just verified for that plugin, compared by
  real path, so a local plugin linked to a folder there is refused. It can't read or list another copy.
- **Never:** your home folder, Ardia's data and config folders, `/Users` and `/Volumes` (an absolute program elsewhere
  reads only itself), any other app's temp files, `/Applications`, `/etc` beyond the files above, pathname sockets,
  shared memory, IOKit, Apple Events, Launch Services, launchd jobs, preference writes and notifications.

`PluginSandboxEscapeTests.swift` proves each line from inside a sandbox, and `mac.yml`'s Swift job runs it on pull
requests that touch `PluginCore`, `PluginProcess.swift`, `plugin-*` or the import readers.

### programs

At most 4. Each is a command Ardia puts on your PATH while the plugin is on: `name` (like a plugin's name) is the
command and `path` an executable file in the plugin's folder. Two more keys need manifest 2:

- **`example`**: a command to try, up to 120 characters, shown with **Copy** on an official plugin's Settings row once
  the program is on PATH (`ardia tabs` for the command line).
- **`claim: true`** (official plugins only): reserves the name. Claims aren't read from whatever is listed. The
  release writes a program registry, `{ "version": 1, "claims": { "<program>": "<owner>" }, "legacyInstalls": [...] }`,
  from the pin alone: each pinned plugin's `reservedPrograms` and `legacyInstall` (`scripts/release/official-plugins.py
  registry`). It goes into `Info.plist` as `ArdiaProgramRegistry`, beside `ArdiaOfficialPlugins` and covered by the
  same signature, and `verify.sh` runs `verify-registry`.
  - The app derives the same registry from its signed pin and refuses one that disagrees (`ProgramRegistry.resolve`).
  - A download's manifest may claim only names the pin reserves for it.
  - Listing (`state/plugins/appChecks.ts`, given the registry by native `programRegistry()`) and the native linker
    (`ProgramRegistry` in `PluginCore/PluginProgramRegistry.swift`) both consult it. A claimed name stays reserved
    while its owner is off, uninstalled or not downloaded, and any other plugin naming it doesn't load ("ardia belongs
    to Ardia's official cli plugin").
  - A registry that is damaged, disagrees with the pin, or is missing from a distributed build fails closed, even with
    no official plugin installed: no program is linked at all, and Settings › Advanced › Programs on your PATH says the
    list is missing or damaged. JS does the same.
  - Only a test instance (a scratch data dir and not signed for distribution) may do without one: it derives the
    registry from its pin (`ARDIA_TEST officialPin`).

Ardia never runs a plugin's program itself, with one exception for official plugins:

- **`afterUpdate`** (official plugins only, from a fetched copy; a plugin you install that declares it doesn't load): up to 4 argument lists,
  each 1 to 8 arguments, that Ardia runs the program with once per new version, in order, each with a 5 minute limit.
  It's a fixed action the app itself declares, not something a plugin can bring: it runs the verified copy by its
  absolute path in its own version folder (never `current` or PATH), with Ardia's environment minus its own variables,
  no input and output to nowhere. One Ardia at a time claims the version (`.after-update-claim`, holding its process
  id; a claim from a process that's gone is taken over) and leases it while the commands run. Each command is started
  under the plugin's store lock and only while that version is still `current` and the request that made it the
  latest, in a process group of its own, which is ended when its time is up and when Ardia quits. Quitting holds new
  commands back from the moment it starts (a cancelled quit picks the list up again at the command it held back or cut
  short, if the version is still current), and before the quit finishes each
  running group gets TERM, then KILL after 1 s, and is reaped; quit gives them one 2.5 s deadline, and Chromium's final shutdown only waits out what's left of it. A
  command that exits on its own has whatever it left in its group sent TERM, then KILL after 3 s, before it counts. Only
  when every command exited 0 is `.after-update` written; otherwise the next launch runs them again. The `cli` plugin runs `skills install --auto`, `skills refresh` and `computer refresh`, as
  `install.sh` did after an upgrade.

- **Turning on** copies the approved folder into a store Ardia owns,
  `~/Library/Application Support/Ardia/Programs/<plugin>/<version>-<first 12 hex of the approval>/`. The copy is made
  through the approved, opened folder, one directory descriptor at a time (`openat` with `O_NOFOLLOW`, each file cloned
  with `fclonefileat` from the descriptor it was opened by), never by path, so a folder put in place after the
  approval is never read. A link anywhere in it (a hard link too), a FIFO, socket or device, a name with control
  characters, or a top-level `.leases`, `.after-update` or `.after-update-claim` refuses the plugin; `__pycache__`
  folders are left behind; file modes are cut to `0755`, so set-user-ID bits and group or other write never survive.
  Then its `plugin.json` must still hash to the approval and each program must be an executable file. An existing copy
  is reused only if it still passes the same checks (through the opened copy) and, for a built-in, the same digest; a
  copy that doesn't is never deleted in place, since a program may be running from it: a new one is made beside it
  (`<version>-<approval>-r<random>`), and the old one goes once nothing leases it.
  It gets an empty `.leases/` folder, and `current` is switched to it with one rename (`previous` keeps the version
  before). Then `~/.local/bin/<name>` links to `Programs/<plugin>/current/<path>`, so an update never touches the link.
  Programs run from Ardia's copy, never from the plugin's folder or the app bundle, so an app update or a replaced
  folder never pulls files out from under a running program.
- **PATH.** When `~/.local/bin` isn't mentioned in your shell's startup files, Ardia adds the line `install.sh` adds:
  `export PATH="$HOME/.local/bin:$PATH"` to `~/.zprofile` (`~/.bash_profile` for bash), or
  `contains -- $HOME/.local/bin $PATH; or set -gx PATH $HOME/.local/bin $PATH` to `~/.config/fish/conf.d/ardia.fish`.
- **Never in the way.** A name that is already a program in `/usr/bin`, `/bin`, `/usr/sbin`, `/sbin`,
  `/opt/homebrew/bin` or `/usr/local/bin` isn't linked ("git would hide /usr/bin/git"), since `~/.local/bin` usually
  comes first on PATH.
- **Whose link.** A name that's free is linked without replacing anything, so two Ardias racing for it can't both
  win; all of this happens under one lock for the bin folder (`Programs/.bin.lock`). Ardia replaces only a link that
  already points into that plugin's store, or, for a registry legacy install's owner only, into that old home (below). A file, or a link to
  anywhere else, is left alone and the plugin's page says so ("~/.local/bin/ardia is someone else's; remove it to use
  this one"); a link into another plugin's store names that plugin. Two plugins that are on never share a command.
- **Leases.** A program that wants its version kept while it runs writes `<its version folder>/.leases/<pid>` at start
  and removes it at exit (the folder above `bin/`; the `ardia` command does). A lease counts
  while that process runs and started no later than the lease's modification time, so a reused process id pins
  nothing; others are cleared. Ardia keeps `current`, `previous` and every leased version, and deletes the rest each
  time it links or unlinks, holding `Programs/.<plugin>.lock` while it does, so two Ardias never sweep or link the same
  plugin at once.
- **Turning off** removes the links that still point into the plugin's store, `current` and `previous`, and every
  version no running process leases. Remove does the same and then deletes the plugin's store folder once nothing is
  leased. At the first scan after launch, every link into the store whose plugin isn't on (or isn't there any more,
  however it went) comes off, and those plugins' stores are swept; a plugin that dropped a command loses that link
  the next time it links.
- **Adopting an old install.** The program registry's `legacyInstalls` come from the pin's `legacyInstall` on a plugin
  (`{ "program": "ardia", "root": "Library/Application Support/Ardia/CLI", "current": "current" }`); `root` must be one
  of the known legacy app-data roots (`KNOWN_LEGACY_ROOTS` in `official-plugins.py`, `knownLegacyRoots` in Swift) and
  `current` one file name. Native checks the exact old layout, walking from the home folder with no-follow checks on
  every folder: `<root>/<current>` is a link to a version folder beside it, and that folder's `bin/<program>` is a
  regular file. JS asks `legacyProgramsInstalled()` once per launch, which answers the owners found, and installs an
  always-on owner that isn't installed yet (only while control is on; an Off you chose is never overridden). Once the
  program is linked, and while the old installer's lock (`<root>/.lock`) is free, the old home's `current` becomes a
  link to `Programs/<owner>/current`, so paths saved through it keep working; only once it does are its old version
  folders deleted, each a real folder inside that home and once no running program leases it; its other files stay.
  All of it goes through directory descriptors: the home is opened one folder at a time with `O_NOFOLLOW` (each owned
  by you), the lock must be a regular file you own, and the lock is taken right after the new version is staged,
  before anything changes, and held through the check of the old layout, Ardia's own `current`, the PATH link and the old
  home's `current` alike. While the old installer holds it nothing is switched: Ardia's `current` stays where it was (so
  PATH runs the same file, even through an old home already adopted), no link changes, native answers `busy`, and no
  `afterUpdate` starts. The swap and the pruning are
  `renameat`/`unlinkat` inside the opened folder. A link on PATH is taken over only when it points at the
  exact old launcher, `<root>/<current>/bin/<program>`. Native answers `adoption`: `adopted`, `already` (it was
  Ardia's), `failed` (the swap didn't take), `busy` (the old installer holds its lock) or `none`. A busy lock is tried
  again, for an Install and an automatic adoption alike (6 times, 5 s apart), then shown with **Try Again**, as a
  failed swap is. `plugin_adoptions` counts, and a waiting Install settles, only once native says `adopted` or
  `already`; `usage_counts.program_adoptions` counts the old home switched over.
- **Official plugins' files** are checked against the download. The fetch records the payload digest of the verified
  copy, derived from the kept download whose SHA-256 the signed pin names (the same digest
  `scripts/release/plugin-digest.py` computes). Ardia computes it again over its program copy before using it, and
  again when it reuses one, and refuses one that differs. What goes on PATH is what the pin vouches for, even if the
  store was changed on disk.
- **Which Ardia writes there.** Only an Ardia on its real data folder links into `~/.local/bin` and the store. A test
  instance (`ARDIA_DATA_DIR`) links only into `ARDIA_INSTANCE cliBinDir=<dir>`, keeps its store in
  `<data dir>/Programs`, adopts an old install only from `ARDIA_INSTANCE cliHome=<dir>` (the old home itself; the key keeps
  its name for the test harnesses, and is passed to `afterUpdate` as `ARDIA_CLI_HOME`) and never from the real home, a
  signed smoke instance included: it keeps the signed claims but adopts nothing without that scratch folder,
  and runs `afterUpdate` with `HOME` at `<data dir>/ProgramsHome`. Plugins belong to the data
  folder, not to a profile, so one link serves every profile; two copies of Ardia.app on one data folder share
  `plugins.json`, their version folders never collide, and the last to link wins.
- **Stale requests.** Each link and unlink takes the plugin's next generation when it's asked for, and does nothing when
  a newer one was asked for before it runs; its answer to JS is only whether it worked, which commands were linked or
  refused and why, the bin folder, whether an old install was adopted, and whether its lock was held (`adoptBusy`).
- **A plugin's own status** (v2 host API): `programs.status` answers `{ state: "none" | "linking" | "linked" |
  "failed", linked, failed: [{ name, reason }], binDir }` for the calling plugin's programs only, and `programs.relink`
  links them again in place: the links stay on PATH while it runs and are replaced only where they changed, and an old
  install's adoption is tried again (refused while a link is under way or when it has none). The SDK has them as
  `ardia.programs.status()` and `ardia.programs.relink()`. Settings › Advanced › Programs on your PATH lists every plugin
  that is on and owns programs, with the same status and **Try Again**.
- **PATH line** (`PluginCore/PluginLoginPath.swift`). Each time a plugin's commands are linked into `~/.local/bin`,
  Ardia reads (never runs) the startup files your login shell reads and, when none has an uncommented line that puts
  `.local/bin` on PATH, appends one to that shell's login file:
  - zsh reads `.zshenv`, `.zprofile`, `.zshrc` and `.zlogin`, and gets `.zprofile`;
  - bash (a login shell, as terminals on macOS open) reads the first of `.bash_profile`, `.bash_login` and `.profile`,
    and `.bashrc` only when that file sources it; the line goes in that first file, or a new `.bash_profile` when there
    is none, so an existing `.profile` is never hidden;
  - fish reads `config.fish` and gets `conf.d/ardia.fish` in its config folder (`$XDG_CONFIG_HOME` included);
  - sh, dash, ksh, mksh and yash read and get `.profile`;
  - csh, tcsh and other shells are left alone, since the line's syntax differs.

  `Programs/.path-line` records the shell and the file that covers it. Nothing is skipped because of it, so a changed
  login shell or a removed line is repaired at the next link. The old `install.sh` asked the login shell for its PATH
  and wrote `.zprofile` (`.bash_profile` for bash), so an adopted install already has its line where zsh and bash
  read it.
- **Not sandboxed.** A program isn't a helper: you, or a program you use, run it from a shell, as you, so neither the
  sandbox nor the plugin's other permissions apply to it, and the consent sheet says so ("Adds ardia to your PATH. It runs as you,
  outside Ardia's sandbox", and "Adds ~/.local/bin to your PATH in your shell's login file"). It reaches Ardia the way any program does, while "Let the ardia command control Ardia" is on: the
  control socket, which checks only that its peer runs as the same user, and the engine's token connection, whose token
  sits in `ArdiaControl.json` for the user's processes to read (`docs/cli.md`, `docs/control-socket.md`). Nothing can
  hold a program running as you to less, so a plugin with programs says so first, whether or not it asks for `control`
  ("The <name> command runs as you, so while control is on in Settings › Advanced, it can fully control Ardia: …",
  or "…, as do the commands Ardia runs for it after updates" for `afterUpdate`), and its row in Settings › Plugins says "Can fully
  control Ardia". A plugin's own code can't reach either. main and a sidecar run under `sandbox-exec`, which denies
  `ArdiaControl.json` and Unix sockets outside the plugin's folder (`PluginSandboxEscapeTests`); a sidecar with the
  network can reach the engine's loopback port, but only the token opens it. Its pages are WebKit views that load the
  plugin's own folder through its scheme handler (`PluginPageView.swift`), with no file access to the data folder, and
  anything they send to the port carries an `Origin`, which the engine refuses.

Code: `PluginCore/PluginPrograms.swift` (the store, links and leases; `plugin-tests/PluginProgramsTests.swift`),
`PluginCore/PluginProgramRegistry.swift` (claims and legacy installs; `plugin-tests/PluginProgramRegistryTests.swift`),
`PluginProgramLinks.swift` (places, PATH, the signed digests), `state/plugins/programs.ts`, `state/plugins/programRegistry.ts`.


### passwordManager

Makes the plugin a password manager each profile can pick. Mac only: Linux and Windows don't show the choice and never
call the Mac verbs below (`PLATFORM_FEATURES.systemPasswordManagers`). One per manifest; any number of plugins may
declare one, and each group of profiles that shares browser data picks at most one.

```json
"passwordManager": { "fill": "system", "fields": ["login", "oneTimeCode"], "verificationCodeSetup": "system", "passkeys": "system" }
```

- `fill` (required): `system` is macOS's own Passwords panel at the field, which types the chosen login into the page.
  The panel lists every saved login, not the site's first: macOS takes a site to filter by only from apps holding Apple's
  private `com.apple.textInput.autofillContext` entitlement (AutoFillCore checks it), and AppKit gives native
  views no site of their own. So once the panel is on screen, Ardia shows a hint beside the key, on the side the panel
  doesn't cover: "Type github in Passwords to find this site", with the page's registrable domain label. It closes with
  the panel, when focus leaves the field or the page navigates, and a profile stops seeing it after closing it 3 times.
  `tool` is reserved (below) and refused for now ("passwordManager.fill: tool isn't available yet; use system").
- `fields` (required, 1 or 2): which fields get the key: `login` (username, email and current password) and
  `oneTimeCode`.
- `verificationCodeSetup` (`system`): when a page in a profile using this plugin shows an `otpauth://` link, or a QR code
  on a Chromium page, Ardia offers "Set Up Verification Code in <app>?" and opens it with macOS's handler for `otpauth:`
  (the Passwords app on a stock Mac). QR codes are found on Chromium pages only: WebKit has no `BarcodeDetector`, so a
  WebKit page that shows its setup code only as a QR image gets no offer; its `otpauth://` links still do. The search
  is bounded so it costs pages little: the first 8 `otpauth` links each time the page changes, and QR codes only on a
  page with a text field (a setup page asks for a code to confirm it), at most 12 decodes per page until the provider
  set changes. A setup step that shows its QR code before any text field gets no offer for it. The URL, which holds the code's secret, stays in native code: the page script, JS and the prompt see
  an opaque token, single use, bound to the tab, frame, document, profile, provider generation and handler app.
- `passkeys` (`system`): accepted for older manifests and ignored. It used to draw Ardia's passkey access row on the plugin's page, but the plugin can't use passkeys: access to the passkeys saved on this Mac is Ardia's own, through Apple's browser passkey entitlement, in Settings › Engines › Passkeys.

The plugin never sees a secret and never runs code in a page: the key, field detection and code detection are Ardia's
own page script, switched on per profile from the manifest.

**Choosing.** Settings › Profiles › Passwords › Password manager lists Ardia (Chrome's password manager, as before),
each enabled password-manager plugin by its title, and None (when an extension handles logins). The choice is stored
on the profile as `ardia`, `none` or `plugin:<name>`; profiles that share browser data share it; a private window
follows its profile's choice. A stored `plugin:<name>` counts only while the plugin loaded under that name is on and
its manifest is the approved one; otherwise the profile reads as Ardia, and the stored choice comes back with it.

**Default.** A profile that never chose reads as Ardia, unless an official password-manager plugin is on, in which case
it reads as that plugin. Turning on an official one also stores it on every profile that never chose (the consent sheet
says how many, naming the plugin: "Moves 3 profiles that never picked a password manager to <title>"). No official
password-manager plugin ships today: Apple Passwords was one in 0.2.47 and was retired once Apple approved Ardia for
Apple Passwords itself (#3357). An installed plugin moves nobody: each profile picks it. Turning a plugin on never
changes a profile that chose.

**Offer to save.** While a profile's manager is a plugin or None, Ardia's offer to save is off for it; it comes back
when the profile returns to Ardia, unless you had turned it off yourself. `password-manager.json` in the data folder
records which profiles Ardia turned off, so the give-back survives a relaunch. Both directions are crash-safe: turning
off writes the record, then the pref. Giving back is a journal over two launches, because Chrome writes the pref to
disk later: Ardia turns the pref on, then marks the profile in `offerToSaveRestored`; a later launch reads the pref
back and clears the profile from the record only once it reads on, and sets it again if Chrome lost it. A launch never
confirms what it wrote itself. Your own switch wins: turning offer to save on or off yourself clears the profile from
the record before the pref changes, so no later launch undoes it. Profiles that no longer exist are dropped from the
record when the subsystem starts, and profiles that share browser data are given back once, through their shared
engine profile. A record write that fails keeps the request and retries
it every 30 s, doubling to 5 minutes: turning off waits until its own record write lands (a read can't
tell a durable record from a save still staged natively, so an entry that's already there doesn't count), and a failed save native still holds for a retry is always replaced by the next write, even one that looks like no
change, so a stale save can't land later and undo your switch. Each failure counts in `password_manager_record_failed`.
Confirming a give-back writes the pref on once more before clearing the record: the read sees the effective value, so
when an extension forces the setting on, a write Chrome lost is still written again before the record goes. Ardia
can't tell a lost write from an Off made in Chrome's own password settings during the launch that gave it back, so
that Off comes back on at the next launch; an Off made in Ardia's Settings always wins. A record from a newer Ardia (a higher
`version`) is never overwritten: offer to save is left as it is for that run.

**Retired plugins.** `RETIRED_OFFICIAL_PLUGINS` in `state/plugins/lifecycle.ts` maps each official plugin Ardia no
longer ships (`apple-passwords`) to the approvals its bundled copies were given (the hash of the bundled manifest with
folder `bundled`). Once a scan lists no plugin by that name, a record carrying one of those approvals is dropped from
plugins.json. A record you approved for a plugin of that name you installed yourself never matches, so it stays even
when a folder read error lists nothing, and a scan that fails drops nothing. Approving or removing a leftover folder of
that name while the bundled record is still there counts as dropping it. In the launch that drops it, a profile
whose stored choice is `plugin:<retired>` is saved as `ardia`,
and when the dropped record was on, so are profiles that never chose, so a rollback to a build that still bundles the
plugin can't hand them back to it with offer to save off. With no retired record and no such choice nothing is
written. Offer to save then comes back through the journal above.

**Withdrawn at once.** Ardia pushes the whole set of profiles with a key (`passwords.setFieldProviders {session, generation,
profiles: [{profile, fields, codeSetup}]}`) at launch and whenever it changes. Turning the plugin off, removing it or
changing its manifest pushes the set without its profiles before the plugin is reported off, so the key leaves every
live page first. Each push has a new generation; native drops badge clicks, menu requests, code detections and token
redemptions from an older one, and the verification code prompt closes on every push and on navigation.

**Accepted residual risk (the page script).** In Chromium the page script runs in the page's own JavaScript world, so a
page can see and fake what it reports. Native is the authority: it opens the panel only when the tab's window is key,
the page's view is first responder and editing text, the top frame last reported focus on a login or code field (in
itself or a same-origin frame it can read) after the latest focus change, and the 0.6 s throttle allows it. A page that
opens the panel without a click gets what Edit › AutoFill gives it: macOS's panel, then Touch ID and a pick by you,
filled into the page's own focused field. The menu route asks the top frame for a fresh focus report and opens only on
its answer within 200 ms. Between the page sampling which field has focus and Ardia opening the panel, focus can still
move inside the page; the panel then fills whatever field macOS sees as focused, as Edit › AutoFill does.

**Edit › AutoFill › Passwords…** in a profile whose manager is a `fill: "system"` plugin opens the macOS panel at the
focused field (`passwords.showSystemPanel {tab, generation}`, in Chromium and WebKit tabs; a request from an older generation is refused as `stale`); otherwise Chrome's dropdown as before.

**An otpauth link you click** still goes through the external-app prompt every link to another app gets, which shows
the address in Ardia's own interface. That's base behaviour, unchanged; no plugin, log or count sees the address.

**`fill: "tool"` (reserved, #1168).** For managers with their own vault (1Password, Bitwarden, Proton Pass). Not a
normal tool: a host-only request the CLI and other plugins can never call, versioned, bound to the exact origin and
form it fills, cancellable, with a consent line naming that the origin is sent to the plugin. The host would type the
answer into that one field. Not built.

#### Host extension points for credential providers

What a password-manager plugin relies on, all host code a plugin can't reach past: the per-profile choice
(`state/site/passwordManagerChoice.ts`), the provider push and withdrawal (`state/site/passwordManager.ts`, the store's
`beforePluginsCommit` seam in `state/plugins/store.ts`), the key and code detection in both engines' page scripts, the
native verbs in `PasswordsModule.swift` (`passwords.setFieldProviders`, `showSystemPanel`, `systemPanelAvailable`,
`otpauthHandler`, `setUpVerificationCode`) and the page events `fieldProviderOpened {via, shown}` and
`verificationCodeFound {token, main}`. A plugin adds none of these; its manifest switches them on.

### siteSwitches

Manifest 2, in `contributes`. Up to 4 switches Site Controls shows for each site, as a row titled `title` with `icon`
(an SF Symbol name, default `puzzlepiece`). Mac only (`PLATFORM_FEATURES.plugins`).

```json
"siteSwitches": [{ "key": "on", "title": "Developer Mode", "icon": "hammer" }]
```

- A row appears in Site Controls for an http(s) page in a tab, never in a private window, a Peek or an internal page
  (`ardia://…`). Pressing it turns the switch on or off for that page's origin.
- Values are kept per **canonical origin**: scheme, host and port, lowercased, the host's trailing dot dropped, default
  ports left out and IPv6 hosts in brackets, so `http://localhost:8318` and `http://localhost:5173` are separate
  sites. Each value is an explicit on or off; a site you never touched has none (and reads as off).
- They are stored in `plugins.json` beside the plugin's record (`sites: { <key>: { <origin>: true | false } }`), on this
  device and for all its profiles, and never in `values`: main, the sidecar, the `plugin.values` event, the socket and
  the `ardia` command never see them, and no plugin API reports a site's value or which sites match.
- Turning the plugin off withdraws its rows (and its page bar) at once; the values stay for when it's back. Removing the
  plugin deletes them with its record.

### pageBar

Manifest 2, in `contributes`. One per plugin: a bar Ardia draws for a page whose site switch is on, with buttons that
run Ardia's own actions on that tab. The plugin declares it; Ardia draws all of it, and no plugin code runs in the
browser's interface. It needs no `main` and no permission; the consent sheet lists the switch, the bar and its
actions.

```json
"pageBar": {
  "look": "stripes",
  "when": { "siteSwitch": "on", "localAddresses": "localAddresses" },
  "buttons": ["siteControls", "address", "copyLink", "|", "console", "network", "inspect", "|", "extensions", "split"]
}
```

- `look` (required): `stripes`, Arc's striped developer bar. With the address in the sidebar (or no toolbar), it is a
  strip above the page with the page's address in a monospaced face; with a toolbar, the toolbar's address field
  takes that face and the DevTools buttons the bar declares.
- `when.siteSwitch` (required) names one of the plugin's `siteSwitches`: the bar shows on sites where it is on.
- `when.localAddresses` (optional) names one of the plugin's `toggle` rows. While that row is on, typing or picking a
  local address in the address bar (`localhost`, `*.localhost`, `127.0.0.0/8`, `0.0.0.0`, `[::1]`) turns the switch on
  for that origin. It is a one-use intent recorded at the address bar's commit, tied to that tab and that origin, spent
  on the tab's next document and dropped if that document is anything else. Redirects, links, pages a site opens,
  restored tabs, the `ardia` command, automation and links from other apps never turn anything on, and a site you turned
  off stays off. So an OAuth callback on `127.0.0.1` that another site redirected you to gets no bar.
- `buttons` (1 to 16): host actions from one table, each at most once, with `|` for a divider. `siteControls` opens
  Site Controls, `address` makes the address editable (without it the address is a plain label), `copyLink` copies
  the page address, `console`, `network` and `inspect` open DevTools there (Chromium pages only; `network` where the
  platform has DevTools panels), `extensions` is the extensions menu, `split` the menu that adds a split on a side.
  The schema and the consent lines come from the same table (`HOST_ACTIONS` in `lib/pluginPageBar.ts`).

**When it shows.** One host function decides for every pane from the window's real layout
(`pageBarFor` in `state/plugins/pageBar.ts`): the pane is the visible one (or one of a visible split), not a warm,
lingering, covered, discarded, sleeping or frozen pane, not a Peek, not a tab of another profile or a private window,
not in a small window, and neither the page nor the window is full screen. The same result draws the strip, the
toolbar's field, split panes' toolbars and the frozen page's offset, so a tab further down the sidebar never draws its
bar over the one you're on. None of it runs until an enabled plugin declares a page bar (`PLUGIN_CHROME.pageBars` in
`state/plugins/chrome.ts`).

**Which document.** The decision uses the page's committed document as the web view reports it (`committedUrl`,
`committedAt`), never the address while it loads: no bar while the shown and committed addresses differ, a new document
shows its bar once it has stayed committed for 300 ms (a page that redirects away sooner never shows it), a change
within the same document keeps the decision and only updates the address, and switching to a tab whose document has
settled shows it at once. The address shown and every action's target are that confirmed document's.

**Actions.** Only the buttons Ardia draws run them. Ardia resolves the target tab when you press, checks it again after
a menu closes (the split menu), and returns nothing to the plugin.

**Several plugins.** When more than one plugin's bar matches a page, the first by plugin name draws it.

#### Host extension points for page bars

All host code a plugin can't reach past: the manifest checks (`lib/pluginPageBar.ts`), the site switch store and the
typed-address intent (`state/plugins/siteSwitches.ts`, `typedAddresses.ts`), the document tracker
(`state/plugins/pageBarDocuments.ts`), the per-pane decision and its published result (`pageBar.ts`,
`pageBarPanes.ts`), the actions (`hostActions.ts`), the bar's components (`components/plugins/PluginPageBar.tsx`,
`PageBarButtons.tsx`, `SiteSwitchRows.tsx`) and the web view's commit reports. Commit reports are off unless a reader
asks: automation's event feed and page bars each ask as their own reader (`reportPageCommits(reader, on)` in
`platform/tabs.ts`), which keeps the set and sends `tabs.reportCommits {on}` only when the first reader starts or the
last one stops, so one stopping never turns them off under the other; a call native refused is sent again on the next
change. The tracker keeps each tab's last report, so pages already open show their bar as soon as a page-bar plugin
turns on, and on the Mac pages already open report again when reports turn on. A page that crashes or is discarded
forgets its document until it commits a new one, and its old report can't bring it back. A typed local address is
kept as an intent only while a page-bar plugin is on, for at most 20 s, and is spent only by the navigation it started:
the address bar's own navigation of that tab (a `tab.opening` hook may hold it and let it through unchanged; one that
cancels or redirects it leaves nothing to spend), or the new tab it opened. It goes with the tab. A typed address
opened in a split or a new window, from a frozen pinned copy, or in a new tab a hook held, records no intent.


### The channel

Descriptor 3 is a Unix stream socket to Ardia speaking the control socket's protocol (`docs/automation.md` ›
Protocol: newline-delimited JSON, the same limits), private to this helper: nothing else can connect to it, and it
works whether or not "Let the ardia command control Ardia" is on. A helper should exit when it closes. A helper that
closes descriptor 3 itself but keeps running is still the plugin's running helper: it gets no calls, events or page
messages, its callers' tool calls fail at their deadline, and Restart (or exiting) starts it over.

Requests from the helper (`{"id", "method", "params"}`):

| Method | Needs | Result |
| --- | --- | --- |
| `hello` | | `{"app", "version", "protocol", "plugin", "values"}`: `values` are the row values. `protocol` is 1 for a sidecar or v1 helper and 2 for main's host, so a helper written for v1 keeps working |
| `values` | | the row values |
| `subscribe` `{"events", "idle"?}` | the events in `hooks` | `{"ok": true}`; then `{"event", "time", "data"}` lines as on the socket; `["*"]` means every event in `hooks` |
| `windows` | `tabs` | as on the socket |
| `run` `{"command", "arg"?, "window"?, "tab"?}` | `commands` | as on the socket |
| `open` `{"urls", "activate"?}` | `commands` | opens 1 to 10 `http:` or `https:` URLs as background tabs in the last focused window (`activate` selects the first there without raising the window). Each URL, at most 2048 characters, is parsed whole as http or https with a host, before anything opens: the host as written must be ASCII (a Unicode name is refused; send it in punycode, `xn--`), with no user name or password and a port from 1 to 65535; an IPv6 host is put in its short form, and dotted IPv4 must have four parts. Raw spaces (percent-encode them), backslashes and control characters are refused before parsing. What opens is the normalised address: scheme and host lower-cased, the default port dropped, non-ASCII in the path, query and fragment percent-encoded as UTF-8, everything else as given. Anything else (`file:`, a path, `ardia:` or `chrome:` pages, `about:`, `javascript:`, `data:`, `ardia-plugin:`) is `bad_request`, and the message names the first bad entry, as in `urls[1] isn't a valid address`. It runs only while the run that asked is still the plugin's current run and still has `commands`; one queued behind other work when that stops opens nothing. Answers `{"ok": true, "tabs": [ids]}`: the tabs it made, nothing else |
| `apply` `{"ops"}` | `workspace`, or `tabs: write` for `open`, `tab.close` and `tab.activate` | as on the socket, except that every URL in `open` and `group.create` is read by `open`'s rules above (http or https only). A batch with any other address is `refused` whole before anything in it runs, and the message names the address |
| `page.post` `{"message", "view"?}` | a `page` | `{"ok": true}`, or `overloaded`: a message to the plugin's page views ([Pages and their helper](#pages-and-their-helper)); `refused` for a plugin with no page, however the method name is spelled in JSON |
| `page.open` `{"path"?, "split"?, "side"?, "context"?}` | a `page`; `context` needs `tabs` | `{"tabId", "windowId"}`: opens the plugin's page at that path in the last focused window, as a tab or in Split View beside the current tab |
| `tools.call` `{"plugin", "tool", "input"?}` | every permission the other plugin has | the tool's result, or its error; the plugin must be on and running. A plugin can't reach through another plugin's tools to what it wasn't granted itself |
| `result` `{"call", "result"? , "error"?}` | | `{"ok": true}`: the answer to a call (below) |

A method the manifest doesn't allow is `refused`. Page messages arrive as `{"pageMessage", "view"}`. Events from Ardia: `plugin.values` (`{"values"}`) when you change a
row, plus the subscribed events. Calls to a tool arrive as `{"call": "c4", "tool": "hello", "input": {…},
"caller": {"kind": "command" | "cli" | "plugin", "plugin"?}, "deadline": ms}`, where `"cli"` means a call through the
control socket, whatever program sent it (inside Ardia it is the `socket` caller; the wire keeps `"cli"` for protocol 1
helpers and protocol 2 runtimes alike); the helper answers with `result`. A
call past its deadline, or one whose calling plugin's helper stops, is answered with an error for the caller and
`{"call": "c4", "cancel": true}` is sent; a late `result` is `bad_request`. At most 16 calls wait per helper.

### Pages and their helper

A plugin's page and its helper talk through Ardia, never over a port:

- **Page to helper.** `window.ardia.send(value)` sends any JSON value; the helper gets a line
  `{"pageMessage": value, "view": "v3"}`, where `view` names that page tab's view. Only the main frame of the
  plugin's own `ardia-plugin://<name>/` documents can send. At most 64 KB per message and 100 messages a second per
  view; more is dropped.
- **Helper to page.** `page.post {"message": value, "view"?: "v3"}` (at most 256 KB) fires a `message` event on
  `window.ardia` in that view, or in every view of the plugin when `view` is left out; the value is `event.data`.
  Each view holds at most 64 messages or 1 MB waiting, delivered in order a few at a time; past that `page.post`
  answers `overloaded` and queues nothing, so a helper should wait for the page (or slow down) and send again. `ok`
  means queued, not received: a message delivered before the page has loaded (before `window.ardia` exists) is
  dropped, so a helper should post to a view only after that view's first message.
- **Bound to a run.** Each page's web view gets its own bridge, fixed when it is made to that web view, the plugin, its
  approval, the run of the helper and a view id that is never used again. A message counts only if it comes from
  that same web view, and goes only to that run; `page.post` reaches only bridges of the run that sent it. The bridge
  is revoked, and everything waiting for it dropped, whenever the page leaves its window (its tab closes, or anything
  above it is taken out), the helper restarts or the plugin is approved again; a new run or approval reloads the
  page, and a page that comes back into a window gets a new bridge with a new view id. A bridge exists only while the
  page is in a window: a page rebuilt while a view above it is out of the window (a restart while its pane moves
  between windows or splits) gets no bridge and doesn't load until it is back, then gets its bridge first and loads
  after. Like Ardia's own pages, a plugin page exists only while its tab shows: switching to another tab unloads it,
  and switching back loads it again with a new bridge. Keep what must survive in the helper or the page's own storage.
  So a helper should answer the `view` of the latest message, or post without one. While no helper runs, `send` does
  nothing.
- **The boundary is the plugin's origin.** Ardia puts `window.ardia` only into the main frame of the plugin's own
  documents, and only that frame's messages are taken. A same-origin child frame (one of the plugin's own files, or an
  `about:blank` frame that inherits the origin) can reach the parent's `window.ardia` through ordinary DOM rules, as
  any same-origin script can: that is the plugin's own code. Nothing from another origin reaches it, and a page can't
  load another origin's frames in the first place.

A page with live data (a chat) is static files that bridge through their helper:

```js
const log = document.querySelector("#log");
window.ardia.addEventListener("message", (event) => {
  if (event.data.token) log.textContent += event.data.token;
});
window.ardia.addEventListener("context", () => render(window.ardia.context));
document.querySelector("form").addEventListener("submit", (event) => {
  event.preventDefault();
  window.ardia.send({ ask: event.target.question.value, context: window.ardia.context });
});
```

and its helper answers each `{"pageMessage": {"ask"}, "view"}` line by streaming `page.post {"view", "message":
{"token"}}` lines back, holding whatever connection it needs (to the model, to a local runtime) itself.


## The page

The page tab's content is a WebKit view (`WKWebView`), not a Chrome page, so nothing in it touches a Chrome profile,
whichever profile the tab's window shows:

- **Its own storage.** Each plugin's page has its own website data store (`WKWebsiteDataStore(forIdentifier:)`, an id
  derived from the plugin's name), apart from every profile's cookies, logins and storage, the WebKit page engine's
  stores and other plugins' pages. Removing the plugin deletes it.
- **Away from Ardia's interface.** It runs in WebKit's own processes with no script message handlers, so the page can't
  reach the interface's JavaScript, the store or any native call, with one exception: `window.ardia.send`, in the main
  frame of the plugin's own documents, which reaches only that plugin's helper, as above. It gets no camera, microphone or location, downloads
  are refused, and its JavaScript dialogs are ignored.
- **Its network follows the plugin's.** Without `network`, the page reaches only its own files: Ardia sends a Content
  Security Policy in every response header (scripts, images, `fetch`, WebSockets, `EventSource`, beacons, preloads and
  form posts go only to its own origin; no workers), turns DNS prefetching off, gives the page's WebKit configuration
  no network hosts at all (so speculative preconnects, which don't consult the policy, open nothing; its own files
  come through Ardia, not the network), and turns WebRTC off, so `RTCPeerConnection` doesn't exist and no ICE packet
  leaves. Each of those, `<link rel=preconnect>` and `dns-prefetch` included, was tried from a test page against
  listeners on this Mac's network address, and none reached them (see the proof in the pull request). A file page
  can't send its own response headers, so a `Link` preconnect header can't arise. The network-host and WebRTC switches
  are WebKit settings that aren't public API. Ardia reads both back after setting them, on the configuration and again
  on the web view's own copy of it; on a macOS where either is missing or doesn't take, a page without `network` isn't
  shown at all rather than shown with the network open. With `network`, a page is a web page like any
  other.
- **Stays on its origin.** Its own files may navigate among themselves. Every other navigation is cancelled: a
  link, a `window.open`, a pop-up, a form post or a download never leaves the page, and a plugin page never opens a
  browser tab by itself. To open one, the page asks its helper, and a helper with the `commands` permission (shown on
  the consent sheet as "Runs Ardia commands, like opening and closing tabs") opens it with `open`:

  ```js
  document.addEventListener("click", (event) => {
    const link = event.target.closest("a[href^='http']");
    if (link) { event.preventDefault(); window.ardia.send({ open: link.href }); }
  });
  ```

  and the helper answers `{"pageMessage": {"open": url}}` with `{"id": 7, "method": "open", "params": {"urls": [url]}}`
  (every request needs its own `id`, echoed in the reply). A
  plugin without `commands` can't open tabs.


### Theme tokens on web pages

Every `PluginPageView` (a page tab, a `WebView` node, a web panel) gets Ardia's current colours as CSS custom
properties, in a `<style id="ardia-theme">` that a script in its own content world injects at document start and
updates live whenever the theme, appearance or profile tint changes (`lib/pluginThemeCss.ts`,
`components/plugins/pluginThemeCss.ts`). Each theme role becomes `--ardia-<role>` in kebab case (`--ardia-background`,
`--ardia-text`, `--ardia-accent`, `--ardia-selection`, …), with `color-scheme` set; values pass a strict filter (no
`url()`, `var()`, `image()` or `expression()`), so a theme file can't load anything into a page. A page styled with
`var(--ardia-background, Canvas)` matches Ardia in light, dark and every theme with no message passing.

## The ardia command

The `ardia` command is itself a plugin, the built-in `cli` (`docs/cli.md`). `ardia plugins` works on the plugin folder of the config folder it resolves (`--data-dir`, `$ARDIA_DATA_DIR`, else
the installed app's); `enable`, `disable` and `call` need Ardia running with CLI control on.

- `ardia plugins list [--json]`: each plugin, its version, whether it's on and running, what it contributes, and its
  problems. With Ardia reachable it asks Ardia (`plugins` on the socket); otherwise it reads the files.
- `ardia plugins install PATH [--force]`: copies a plugin folder (or a lone `plugin.json`) into the plugin folder,
  after checking it against `plugin.schema.json`. `--force` replaces one already there. The plugin arrives off. The
  copy is published with a rename that never replaces anything (`renamex_np` with `RENAME_EXCL` on macOS,
  `renameat2` with `RENAME_NOREPLACE` on Linux), so an install that appears meanwhile is never overwritten without
  `--force`. A forced replace swaps the new folder and the old one in a single step (`renamex_np` with `RENAME_SWAP`,
  `renameat2` with `RENAME_EXCHANGE`); where that isn't available it moves the old folder aside, and puts it back if
  publishing fails, or, when even that is blocked, keeps it and prints where.
- `ardia plugins check [NAME|PATH]`: checks manifests.

`check` and `install` hold a manifest to what the app accepts, using the `plugin.schema.json` Ardia wrote for that data
folder, else the one built into the `ardia` command (`plugins/cli/ts/assets/` in ardia-browser/plugins); settings defaults need Ardia's
`config.schema.json`, and without it a manifest that sets any is refused as unchecked: a version 0 manifest is migrated first and a newer
version than `plugin.schema.json` knows is refused; then the schema (rows included), the settings defaults against
`config.schema.json`, and the rules a schema can't state (a command's tool exists, `context` needs `tabs`, a page is a file, names are unique, …), with the app's own lists from the schema's `x-ardia-rules` (events that need
`tabs`, page names Ardia keeps, settings with approvals of their own). Only the app knows whether `requires` fits the
Ardia that runs it. `install` checks the copy it is about to publish again. `tests/fixtures/plugins/rejected-manifests.json`
is a list both the app's tests and the CLI's tests refuse.
- `ardia plugins remove NAME`: through Ardia when it is reachable (as Settings' Remove), else deletes the folder. If
  Ardia got the request but its answer was lost, the folder is left alone; run it again.
- `ardia plugins enable NAME`, `ardia plugins disable NAME`. `disable` also works for a plugin that was on when its
  folder was deleted by hand, and puts back the settings it changed.
- `ardia plugins call NAME TOOL [JSON]`: calls a tool and prints its result as JSON (exit 1 on its error).

The control socket's protocol 4 adds `plugins`, `plugins.enable` (`{"waiting": true}` once the sheet is up),
`plugins.disable`, `plugins.remove` and `plugins.call` (`{"plugin", "tool", "input"?}`).


## Code

- `lib/pluginManifest.ts`: parsing and checks, with `pluginContributions.ts`, `pluginCommands.ts`, `pluginRows.ts`,
  `pluginPermissions.ts`, `pluginActivation.ts`, `pluginRuntime.ts`, `pluginWhen.ts`, `pluginNodes.ts`,
  `pluginNetwork.ts`, `pluginProtocol.ts`, `pluginThemeCss.ts`; migrations in `pluginMigrations.ts`, the schema in
  `pluginSchema.ts`; `lib/pluginManifest.test.mjs`.
- `packages/plugin-sdk`: the SDK, JSX runtime, reconciler and hooks; `sdk.test.mjs`.
- `state/plugins/`: the registry (`store.ts`), saved state (`savedState.ts`), turning on and off (`lifecycle.ts`),
  activation (`activation.ts`), settings defaults (`defaults.ts`), the channel (`channel.ts`, `channelApi.ts`,
  `channelData.ts`, `channelUi.ts`), tools (`tools.ts`), commands (`commands.ts`), menus (`menus.ts`), toolbar
  (`toolbar.ts`), surfaces and panels (`surfaces.ts`, `panels.ts`), omnibox (`omnibox.ts`), themes (`themes.ts`),
  decide hooks (`decideHooks.ts`), storage and secrets (`storage.ts`, `secrets.ts`), page tabs (`pages.ts`,
  `pageNames.ts`), consent copy (`consent*.ts`), socket methods (`socketMethods.ts`).
- Where the browser calls in: `App.tsx` (side panel and overlays), `components/toolbar/Toolbar.tsx` and
  `components/sidebar/AddressBar.tsx` (toolbar buttons), `components/sidebar/PageRows.tsx` (sidebar views),
  `state/sidebar/tabMenu.ts` (the tab menu), `state/config/configFiles.ts` (plugin themes),
  `state/automation/decideHooks.ts` (decide hooks after `hooks.json`).
- `state/site/passwordManager*.ts`, `verificationCodes.ts`: the `passwordManager` contribution's host side.
- `lib/pluginPageBar.ts` and `state/plugins/{siteSwitches,typedAddresses,pageBarDocuments,pageBar,pageBarPanes,hostActions,pageBarCommits}.ts`:
  the `siteSwitches` and `pageBar` contributions' host side; `components/plugins/PluginPageBar.tsx`, `PageBarButtons.tsx`,
  `SiteSwitchRows.tsx` draw them.
- `platform/plugins.ts` binds `ArdiaPlugins` (`packages/shell/ios/PluginsModule.swift`, `PluginProcess.swift`,
  `PluginHost.swift`, `PluginHostFetch.swift`, `PluginPageView.swift`, `PluginSchemeHandler.swift`, `PluginCore/`
  (`PluginSandbox`, `PluginFiles`, `PluginFetchPolicy`, `PluginStorage`, `PluginProcessTree`, `PluginRuns`,
  `PluginLifecycle`, `PluginPage*`), tested by `packages/shell/plugin-tests` with `swift test`), and
  `packages/shell/plugin-host` is the host.
- UI: `components/settings/panes/Plugins.tsx`, `components/plugins/` (`PluginPage`, `PluginSidePanel`,
  `PluginOverlays`, `PluginToolbarItems`, `PluginSidebarViews`, the native node renderer, the consent sheets).
- The example plugin used by the tests: `tests/fixtures/plugins/example/`.

## Telemetry

Counts only, never plugin names, titles, URLs, row values, secrets, tool input or output, fetched hosts or view
contents, each tied to the consent period the activity began in, so a count that finishes after sharing changed stays
in the local copy. Hourly `usage_counts`:

- v1: `plugin_enables`, `plugin_disables`, `plugin_process_starts`, `plugin_process_crashes`, `plugin_commands_run`,
  `plugin_tool_calls`, `plugin_tool_failures`, `plugin_page_opens`, `plugin_split_opens`, `program_links`,
  `program_link_failures` (a link refused, a name taken or the copy failed), `program_unlinks`, `program_adoptions`
  (an old `ardia` install's home taken over), `plugin_adoptions`, `plugin_adoptions_waiting`,
  `program_after_update_quit_exits` and `program_after_update_quit_kills` (a built-in plugin's `afterUpdate` command
  still running at quit whose whole process group left on TERM, or was killed after the 1 s grace; tallied natively
  at quit, only while sharing is on and tagged with that sharing period, and counted at the next launch only in the
  same period).
- v2: `plugin_activations` (main started by an activation event), `plugin_activation_failures`,
  `plugin_surface_renders` (a native view committed), `plugin_panel_opens`, `plugin_toolbar_runs`,
  `plugin_menu_runs`, `plugin_action_shortcuts` (an action run by its declared shortcut), `plugin_omnibox_queries`,
  `plugin_ui_prompts` (a quick pick, input box or confirm shown),
  `plugin_net_fetches`, `plugin_net_refusals` (a fetch outside `permissions.network` or to a private address),
  `plugin_url_refusals_open`, `plugin_url_refusals_group_create` (an `apply` batch refused for an address outside the
  plugin URL rules, such as one that isn't http or https or has a user name and password, by the operation that held it),
  `plugin_storage_writes`, `plugin_storage_cancels` (a storage request dropped because the plugin was being removed),
  `plugin_secret_writes`, `plugin_page_reads` (`activePage` reads), `plugin_decide_calls`,
  `plugin_decide_timeouts`.

The daily settings snapshot has `plugins_installed`, `plugins_enabled` and, among those on, how many use each part:
`plugins_with_settings`, `plugins_with_commands`, `plugins_with_page`, `plugins_with_process`,
`plugins_with_programs`, `plugins_with_hooks`, `plugins_with_tools`, `plugins_with_passwordManager`, and for v2
`plugins_with_main`, `plugins_with_menus`, `plugins_with_toolbar`, `plugins_with_sidebarViews`,
`plugins_with_panels`, `plugins_with_omnibox`, `plugins_with_themes`, `plugins_with_siteSwitches`, `plugins_with_pageBar`.

Page bars: hourly `plugin_page_bar_shown_<official|other>` (once per tab per document), `plugin_page_bar_press_<action>`
(`site_controls`, `address`, `copy_link`, `console`, `network`, `inspect`, `extensions`, `split`),
`plugin_site_switch_<on|off>` (your presses in Site Controls), `plugin_site_switch_auto_on_typed` (a local address you
typed turned a switch on) and `plugin_page_bar_superseded` (another plugin's bar matched the same page). Watch
`plugin_page_bar_shown_official` against `plugin_site_switch_off`: a bar shown where people then turn it off is a
misfire.

Password managers: hourly `password_manager_panel_opens_<badge|menu>`, `password_manager_panel_refused_<badge|menu>`,
and each refusal's reason
`password_manager_panel_refusal_<hidden|not_focused|unavailable|not_key|not_editing|throttled|refused|no_panel>`
(`no_panel`: macOS took the request but no panel window was on screen 0.6 s later),
`password_manager_panel_hints_<shown|dismissed>`, `verification_code_setups_<offered|accepted|failed>`,
`password_manager_chose_<ardia|none|plugin>`, `password_manager_record_failed`, `password_manager_profiles_moved_back`
(profiles, counted once per shared engine profile, saved as Ardia because their plugin was retired),
`password_manager_offer_to_save_restored` (a give-back a later launch read back on),
`password_manager_offer_to_save_restore_failures` (the pref couldn't be turned on), and the daily
`password_manager_profiles_<ardia|none|plugin>`.

Dashboard: watch `plugin_process_crashes` against `plugin_process_starts`, `plugin_activation_failures` against
`plugin_activations`, `plugin_decide_timeouts` against `plugin_decide_calls` (a plugin slowing navigation),
`plugin_net_refusals` against `plugin_net_fetches`, `plugin_url_refusals_open` and `plugin_url_refusals_group_create`
(a plugin trying addresses it may not open), `program_link_failures` against `program_links`, and `program_after_update_quit_kills` against
`program_after_update_quit_exits` (afterUpdate commands that ignore TERM at quit).
