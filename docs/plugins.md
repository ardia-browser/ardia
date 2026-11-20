# Plugins

A plugin is a folder with a `plugin.json` that adds to Ardia without a restart: Ardia settings it sets and rows it adds
to Settings, command bar entries, a page of its own that opens as a tab at `ardia://<name>`, a long-running helper
program, browser events delivered to that program, tools the `ardia` command and other plugins can call, and commands
it puts on your PATH. Issue #2462; programs and built-in plugins #2568.

The rule behind the design: anything a first-party plugin needs becomes a public extension point here, never a private
hook. AI features will ship as a plugin (#2463) through exactly these contributions.

Plugins run on macOS. Linux and Windows don't load them yet (`PLATFORM_FEATURES.plugins`): the Plugins pane says so,
and the `ardia` command's plugin commands still install and list files there.

## Where they live

```
<config folder>/plugins/<name>/plugin.json     the manifest, and the plugin's own files beside it
<data dir>/plugins.json                         which plugins are on, what you approved, your row values
<data dir>/PluginData/<name>/                   the helper's home, temp folder and log
Ardia.app/Contents/Resources/Plugins/<name>/    built-in plugins (below)
~/Library/Application Support/Ardia/Programs/   Ardia's copies of the programs plugins put on PATH (below)
```

- The config folder is `docs/config.md`'s (`~/.config/ardia/`, or `<data dir>/config` for a scratch instance), so a
  dotfiles repo can carry plugins. A plugin's folder may be a symlink (Ardia watches its target); its `plugin.json`
  may not: a linked manifest could point anywhere Ardia doesn't watch, so it is listed as a problem. Ardia reads
  regular files only, at most 1 MB per manifest, and at most 64 plugins.
- The folder name is the plugin's `name`. A folder whose name doesn't match its manifest is listed with that problem.
- Ardia watches the folder: a plugin appears, changes or disappears the moment its files do.
- Installing, enabling and the rest need no restart. Turning a plugin off withdraws everything it added at once.

### Built-in plugins

First-party plugins ship inside the app, in `Contents/Resources/Plugins/<name>/`. They're built and released in
github.com/ardia-browser/plugins, unsigned; this repo pins each one's version and SHA-256 per platform in
`apps/browser/official-plugins.json`, and the release fetches, verifies and unpacks them
(`scripts/release/official-plugins.py bundle`, in the Release workflow's `build` job, which holds no secrets), then the
`sign` job signs their Mach-Os with the app's identity and hardened runtime and records their digests in Info.plist
before the app itself is signed (`export-sign.sh`); `verify.sh` checks those digests again on the signed app.
They're listed in Settings › Plugins as "Built in", **off** until you turn them on, and can be turned off but not
removed, unless they're always on (below). The command-line plugin, `cli`, is the first (the `ardia` command,
`docs/cli.md`): an official plugin, always on once installed.

- **Official** (`"official": true`, built-in plugins only) lists the plugin among Ardia's official plugins, the ones
  Settings › Plugins and onboarding offer to install in one click (the seam below). `"icon"` (an SF Symbol, built-in
  plugins only) is its symbol there.
- **Always on** (`"alwaysOn": true`, built-in plugins only; a plugin you install that declares it doesn't load) means
  once installed it stays: no switch in Settings and no way to remove it. Until you install it the plugin is listed
  as "Built in, not installed" and adds nothing; Install opens the consent sheet ("Install Command Line?", button
  **Install**), which saves `{"enabled": true, "approved": <hash>, "installed": true}` in `plugins.json`. From then on
  it's part of the app, sealed by its signature, and an update that changes its manifest needs no new approval. After
  that `enablePlugin`, `disablePlugin`, the consent sheet and `plugins.enable`/`plugins.disable` on the socket refuse it
  (`plugins.enable` answers ok, `plugins.disable` "once installed it stays").
- **Adopted on update**: on the first scan after launch, an always-on plugin that owns a reserved program (`cli`, for
  `ardia`) and isn't installed yet is installed silently when the old installer's home holds a live install
  (`CLI/current` resolves to a version folder), so someone who had `ardia` keeps it with no click and one `ardia` on
  PATH. Only when control is on: with `cliControl` off the old install is left alone and the plugin stays available
  until the user installs it (`ADOPT_WITH_CONTROL_OFF`, false; `usage_counts.plugin_adoptions_waiting`).
  `usage_counts.plugin_adoptions` counts adoptions; one changes no setting.
- **Auto install** (`"autoInstall": true`, built-in plugins only, with `alwaysOn`) installs it on every profile with no
  click, as the CLI was at first. No plugin ships with it today; it's the switch back if that's wanted. Such a plugin's
  first link turns `control` on once (below).

- **Approval** (built-in plugins that aren't always on). The app's signature seals that folder, so a built-in plugin's folder identity is `bundled` instead of a
  device and inode: Turn On approves the SHA-256 of its manifest's text with `bundled`. An update that ships the same
  manifest stays approved; one whose manifest changes needs a new approval, like any plugin.
- **Replacing one** is for development only. In a test instance (`ARDIA_DATA_DIR`), a folder of the same name in
  `<config folder>/plugins/` replaces the built-in plugin, listed as "Replaces the built-in plugin"; its identity is its
  own folder's, so the built-in plugin's approval never carries over to it. Anywhere else the built-in plugin wins and
  its row says the folder is ignored.
- **Test instances** read built-in plugins from `ARDIA_TEST bundledPlugins=<dir>` instead of the app.

### Official plugins: the seam for Settings and onboarding

`apps/browser/src/state/plugins/actions.ts` (and `hooks.ts` for the hook) is the stable API the official-plugins UI
builds on; `programs.test.mjs` and `adoption.test.mjs` pin it.

- `useOfficialPlugins(): OfficialPlugin[]`, a hook, and `officialPlugins(store, supported?, showComingSoon?)`, its pure
  form. `OfficialPlugin` is `{ name, title, blurb, icon, version, switchable, state }` (`switchable`: built in but not always on, so it has an off switch), `state` one of `"available"`, `"installed"`,
  `"comingSoon"`, `"unsupported"`. The list is `OFFICIAL_CATALOGUE` (the plugins Ardia means to ship: `cli` and `apple-passwords` today) plus
  any other built-in plugin whose manifest says `official`; title, blurb and icon come from the bundled manifest when
  there is one. Only a built-in plugin can claim `official`, so a plugin you install never shows here. Where plugins
  aren't supported (Linux and Windows today, `PLATFORM_FEATURES.plugins`), or the app has no bundled copy, every entry
  is `"unsupported"`; Linux's own `ardia` installer (Settings › Advanced) is unchanged.
- `COMING_SOON` entries (the AI plugin) show as `"comingSoon"` only while their experiment is on
  (`officialPluginsAi`, off by default), and never install.
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
  installed reads "Installed · <version>" beside the title, with a first command in mono and **Copy** (where the
  command lives is on the plugin's own page, behind the chevron); a failure shows its reason with **Try Again**;
  coming soon is the title and "Coming soon"; unsupported shows nothing. The list below has one short line, and its
  empty state is "None yet" with **How to add one**, which shows the folder and the `ardia plugins install` hint.
  Settings search finds it as "Command Line" and "Official plugins".
- **Onboarding** has a step between Make it home and the outro (`components/onboarding/PluginsStep.tsx`,
  `state/onboarding/pluginsStep.ts`). The command line starts ticked. **Install** shows the same consent lines inside
  onboarding (`consentLines`, with the same changed-while-open guard) and nothing is installed until **Install** there
  is pressed; **Cancel** returns to the offer; **Skip** installs nothing. A failure shows its reason and never blocks
  Continue. When everything is already installed the step says so, and when nothing can be offered (Linux, Windows,
  the web demo, a build with no bundled copy) the step is left out.
- **Counts** (`state/telemetry/officialPluginCounts.ts`, in the hourly `usage_counts`):
  `official_plugin_<onboarding|settings>_<shown|installed|skipped|failed>_<cli|ai|other>`. `shown` counts a plugin that
  could still be chosen, `skipped` is onboarding only, and a closed consent counts as nothing. Watch
  `…_onboarding_installed_cli` against `…_onboarding_shown_cli` for the take-up, and `…_failed_cli` for a regression.
- On the control socket, `plugins.official` returns the same list; `plugins.enable` on an official plugin opens its
  sheet and answers `{"waiting": true}`.

## The manifest

```json
{
  "$schema": "../../plugin.schema.json",
  "manifest": 1,
  "name": "example",
  "title": "Example",
  "description": "One line on what it does.",
  "version": "1.0.0",
  "requires": "0.2.50",
  "permissions": ["tabs", "commands", "network"],
  "settings": {
    "defaults": { "commandBarStart": { "openTabs": { "limit": 5 } } },
    "rows": [
      { "key": "greeting", "title": "Greeting", "type": "text", "default": "Hello" },
      { "key": "loud", "title": "Shout", "type": "toggle", "default": false },
      { "key": "side", "title": "Open Beside On", "type": "choice", "default": "right", "choices": [{ "value": "left", "title": "Left" }, { "value": "right", "title": "Right" }] }
    ]
  },
  "commands": [
    { "name": "say-hello", "title": "Say Hello", "icon": "hand.wave", "keywords": ["greet"], "tool": "hello" },
    { "name": "beside", "title": "Open Example Beside This Tab", "open": "split", "context": true, "sideSetting": "side" }
  ],
  "page": { "title": "Example", "icon": "sparkles", "file": "page/index.html" },
  "process": { "run": ["/usr/bin/python3", "helper.py"], "memoryMB": 256 },
  "programs": [{ "name": "example-tool", "path": "bin/example-tool" }],
  "hooks": ["tab.activated", "tab.navigated"],
  "tools": [{ "name": "hello", "title": "Say hello", "description": "Greets someone.", "timeout": 10 }]
}
```

- `manifest` is the schema version. A file without it is version 0, the settings-only plugins of
  github.com/ardia-browser/plugins (`name`, `title`, `description`, `requires`, `settings`, `reset`), and reads as
  version 1 with its `settings` as `settings.defaults` (`reset` is the installer's and Ardia ignores it). A newer
  version than Ardia knows is listed as "needs a newer Ardia" and never loads. The migration is
  `lib/pluginManifest.ts`'s `MIGRATIONS`, like every saved document (`docs/conventions.md`).
- `name`: 1 to 40 lowercase letters, digits and dashes, starting with a letter or digit. `title` up to 60 characters,
  `description` up to 200, both with control and bidi characters refused. `version` and `requires` are
  `MAJOR.MINOR.PATCH` with an optional `-suffix`; a plugin that requires a newer Ardia doesn't load.
- Unknown keys anywhere are errors, so a typo never silently does nothing. Every problem is reported at once, with
  its path: `plugin.json: commands[0].tool: hello isn't one of this plugin's tools`. A manifest with any problem
  doesn't load; the Plugins pane shows the problems and `ardia plugins check` prints them.
- The app writes `plugin.schema.json` beside `config.schema.json` (`docs/config.md` › Schemas), generated from the same
  rules, for editors and the CLI. The app validates with its own code.

### settings

- `defaults` sets Ardia settings while the plugin is on. Only settings `config.json` may set are accepted (the config
  allowlist, `docs/config.md`), with the same checks, so a plugin can't turn on CLI control, add a search destination
  or change which engine shows a site. When you turn the plugin on, each default that `config.json` doesn't set is
  applied through `updateSettings` and the value it replaced is remembered; turning the plugin off puts that value back
  unless you changed the setting since or `config.json` now sets it. When two plugins set the same setting, turning either off leaves the other's
  value or, once both are off, the one from before either. `config.json` always wins. `omniboxProviders` and
  `launchActions` have approvals of their own (`docs/automation.md` › Approvals), so a plugin can't set them.
- `rows` (at most 20) add rows to the plugin's page in Settings › Plugins: `toggle` (boolean), `text` (up to 200
  characters, `default` a string) and `choice` (2 to 12 `choices`, `default` one of their values). `key` is 1 to 40
  letters, digits, `-` and `_`. Values are kept in `plugins.json` and sent to the helper (below). They are the plugin's
  own: nothing in Ardia reads them.

### commands

At most 20. Each adds a command bar entry titled `title` (up to 60 characters), found by its title, `keywords` (up to 8,
each up to 40 characters) and the plugin's title, drawn with `icon` (an SF Symbol name, default `puzzlepiece`). A
command does one of two things:

- `"tool": "<name>"` calls one of the plugin's own tools with `input` (an object, default `{}`), so it needs a
  `process`. A result with a `message` (up to 200 characters) shows as a toast.
- `"open": "tab"` or `"open": "split"` opens the plugin's page: as a tab (the one already open in that window, else a
  new one), or in Split View beside the current tab, on `side` (`left`, `right`, the default, `top` or `bottom`), or on
  the side a `choice` row named by `sideSetting` holds (its values must be sides). `"context": true` hands the page the
  current tab (its id, title and URL, without the query and fragment unless the plugin has `fullUrls`), and needs
  `tabs`. `path` (`/history`, `/chats/new?mode=split`) opens the page there.

A plugin with a `page` also gets "Open `<page title>`" for free. Plugin commands aren't offered in private windows, and a page
is never handed a private tab or a Peek: the same tabs hooks and the `ardia` command never see (`docs/automation.md`).

### page

The plugin's page is a real tab at `ardia://<name>`, like `ardia://history`: it sits in the sidebar, takes a place in
Split View and in tab groups, moves between windows and comes back with the session. `title` (up to 40 characters)
names the tab and `icon` its command bar entry. Its content is static files from the plugin's folder:

- `"file": "page/index.html"`: the page, served as `ardia-plugin://<name>/page/index.html` with everything it loads
  from beside it.
  Only regular files inside the approved plugin folder are served, and only while that folder still holds the approved
  `plugin.json`: for every file Ardia opens the folder, checks its identity and the manifest's hash, and opens the file
  one path component at a time from that same opened folder; a link anywhere in its path is refused. An edited
  manifest stops the page's files at once, before the folder watcher reacts. At most 10 MB each, with their type from the
  extension; anything else is a 404.

A page tab can have a path, `ardia://<name>/<path>?<query>` (`ardia://ai/history`, `ardia://ai/chats/42`): each path
is its own tab, and opening one that's already open in the window goes to it. A file page gets the path and query as
`ardiaPath`. When a command hands the page a tab, the page reads it as `window.ardia.context`, a JSON object
`{"tabId", "url", "title"}` with its URL cut to the plugin's permissions, set before the page's own scripts run; a new
one fires a `context` event on `window.ardia`. It is never in the page's URL or in any request. A page talks to its own
helper through Ardia ([Pages and their helper](#pages-and-their-helper)); it never needs a port. The context belongs to that page tab, that plugin and that approval: it goes when the tab leaves the
address it was opened at, and when the plugin is turned off, changes or is approved again. Navigation inside the page doesn't change the
tab's address, title or back and forward yet (follow-up issue). While the plugin is off, changed or not running, the tab stays and says so, with a way to Settings; it is
never sent to Chrome. A plugin with a page can't take the name of one of Ardia's or Chrome's own pages (`history`,
`settings`, `flags`, `extensions`, … `lib/pluginNames.ts`).

### process

`run` is the helper's argv: its first item is a file in the plugin's folder (`bin/helper`), an absolute path
(`/usr/bin/python3`), or a bare name found on `/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin`.
At most 32 items, each up to 1,024 bytes, no NUL. `memoryMB` (64 to 4,096, default 1,024) is a watchdog
threshold, not a hard cap: Ardia checks the helper's own footprint every 10 seconds and stops it when it is over,
so a helper can go past it between checks, and the processes it starts aren't counted. See [The helper](#the-helper).

What the approval pins is the plugin's root folder, not the files in it. A program in the plugin's folder is checked
through the approved, opened folder (one path component at a time, no links, an executable file) and started as
`./bin/helper` with that opened folder as its working directory, so a folder swapped in for the approved one never
runs. The program file itself is looked up again by that path when it starts: whoever can change files inside the
approved folder can change what runs between the check and the start, as they can change the code at any time; the
approval covers the manifest's declarations, not the code. An absolute path or a bare name is outside the plugin:
it is whatever is at that path when the helper starts. The approval names it ("Runs a program in the background:
/usr/bin/python3 helper.py"), it may not live in Ardia's data or config folder, and beyond that it is trusted as
installed, like a hook's program in `hooks.json`.

### programs

At most 4. Each is a command Ardia puts on your PATH while the plugin is on: `name` (like a plugin's name) is the
command and `path` an executable file in the plugin's folder. Only the `cli` plugin may use the name `ardia`. Ardia never
runs a plugin's program itself, with one exception for built-in plugins:

- **`afterUpdate`** (built-in plugins only; a plugin you install that declares it doesn't load): up to 4 argument lists,
  each 1 to 8 arguments, that Ardia runs the program with once per new version, in order, each with a 5 minute limit.
  It's a fixed action the app itself declares, not something a plugin can bring: it runs the verified copy by its
  absolute path in its own version folder (never `current` or PATH), with Ardia's environment minus its own variables,
  no input and output to nowhere. One Ardia at a time claims the version (`.after-update-claim`, holding its process
  id; a claim from a process that's gone is taken over) and leases it while the commands run. Each command is started
  under the plugin's store lock and only while that version is still `current` and the request that made it the
  latest, in a process group of its own, which is ended when its time is up and when Ardia quits. Only when every
  command exited 0 is `.after-update` written; otherwise the next launch runs them again. The `cli` plugin runs `skills install --auto`, `skills refresh` and `computer refresh`, as
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
  already points into that plugin's store, or, for the built-in `cli`
  plugin only, into the old CLI home (`~/Library/Application Support/Ardia/CLI`, adopted below). A file, or a link to
  anywhere else, is left alone and the plugin's page says so ("~/.local/bin/ardia is someone else's; remove it to use
  this one"); a link into another plugin's store names that plugin. Two plugins that are on never share a command.
- **Leases.** A program that wants its version kept while it runs writes `<its version folder>/.leases/<pid>` at start
  and removes it at exit (the folder above `bin/`; the `ardia` command does, in Rust and in Python). A lease counts
  while that process runs and started no later than the lease's modification time, so a reused process id pins
  nothing; others are cleared. Ardia keeps `current`, `previous` and every leased version, and deletes the rest each
  time it links or unlinks, holding `Programs/.<plugin>.lock` while it does, so two Ardias never sweep or link the same
  plugin at once.
- **Turning off** removes the links that still point into the plugin's store, `current` and `previous`, and every
  version no running process leases. Remove does the same and then deletes the plugin's store folder once nothing is
  leased. At the first scan after launch, every link into the store whose plugin isn't on (or isn't there any more,
  however it went) comes off, and those plugins' stores are swept; a plugin that dropped a command loses that link
  the next time it links.
- **Adopting the old install** (the built-in `cli` plugin): once `ardia` is linked, and while the old installer's lock
  (`CLI/.lock`) is free, an old CLI home's `current` becomes a link to `Programs/cli/current`, so paths saved through it
  keep working; only once it does are its old version folders deleted, each once no running `ardia` leases it; its
  other files stay. `usage_counts.program_adoptions` counts it.
- **Built-in plugins' files** are checked against the release: `scripts/release.sh` writes each built-in plugin's
  payload digest (`scripts/release/plugin-digest.py`: one line per file and folder, sorted, hashed) into the
  app's `Info.plist` as `ArdiaBuiltInPlugins`, which the app's signature covers. Ardia computes the same digest over its
  copy before using it, and again when it reuses an existing copy, and refuses one that differs ("its files don't match the ones this Ardia was signed with"), so
  what goes on PATH is what was signed, even if the app's folder was changed on disk. A release build refuses a built-in
  plugin with no digest; a test instance checks only the ones listed.
- **Which Ardia writes there.** Only an Ardia on its real data folder links into `~/.local/bin` and the store. A test
  instance (`ARDIA_DATA_DIR`) links only into `ARDIA_INSTANCE cliBinDir=<dir>`, keeps its store in
  `<data dir>/Programs`, adopts an old install only from `cliHome`, and runs `afterUpdate` with `HOME` at
  `<data dir>/ProgramsHome`. Plugins belong to the data
  folder, not to a profile, so one link serves every profile; two copies of Ardia.app on one data folder share
  `plugins.json`, their version folders never collide, and the last to link wins.
- **Stale requests.** Each link and unlink takes the plugin's next generation when it's asked for, and does nothing when
  a newer one was asked for before it runs; its answer to JS is only whether it worked, which commands were linked or
  refused and why, the bin folder, and whether an old install was adopted.
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
  outside Ardia's sandbox", and "Adds ~/.local/bin to your PATH in your shell's login file"). It reaches Ardia the way any program does: the control socket
  and the token server, while "Let the ardia command control Ardia" is on (`docs/automation.md`, `docs/cli.md`).

Code: `PluginCore/PluginPrograms.swift` (the store, links and leases; `plugin-tests/PluginProgramsTests.swift`),
`PluginProgramLinks.swift` (places, PATH, the signed digests), `state/plugins/programs.ts`.

### hooks

Events from Ardia's automation event table (`docs/automation.md` › Events) delivered to the helper while it subscribes
to them. Every event the helper may subscribe to is listed here, so it shows on the consent sheet. Events about
windows, tabs, pages, media, Peek, pins, splits and profiles need the `tabs` permission. `notification.shown` and the
decide events (`tab.opening`, …) aren't available to plugins yet. Needs a `process`.

### tools

At most 32. A tool is an action the helper performs on request: `name` (like a command's), `title`, `description`
(up to 200 characters), `timeout` in seconds (1 to 300, default 30). Callers: the plugin's own commands, the `ardia`
command (`ardia plugins call`), and other plugins' helpers (`tools.call`). Input and result are JSON, at most 1 MB.
Needs a `process`.

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
- `passkeys` (`system`): the plugin's Settings page shows whether Ardia may use the passkeys saved on this Mac, with
  macOS's access request. It says plainly when the build lacks Apple's browser passkey entitlement (every build today).

The plugin never sees a secret and never runs code in a page: the key, field detection and code detection are Ardia's
own page script, switched on per profile from the manifest.

**Choosing.** Settings › Profiles › Passwords › Password manager lists Ardia (Chrome's password manager, as before),
each enabled password-manager plugin by its title, and None (when an extension handles logins). The choice is stored
on the profile as `ardia`, `none` or `plugin:<name>`; profiles that share browser data share it; a private window
follows its profile's choice. A stored `plugin:<name>` counts only while the plugin loaded under that name is on and
its manifest is the approved one; otherwise the profile reads as Ardia, and the stored choice comes back with it.

**Default.** A profile that never chose reads as Ardia, unless a built-in password-manager plugin is on, in which case
it reads as that plugin. Turning on a built-in one also stores it on every profile that never chose (the consent sheet
says how many, naming the plugin: "Moves 3 profiles that never picked a password manager to Apple Passwords"). An installed plugin moves nobody: each
profile picks it. Turning a plugin on never changes a profile that chose.

**Offer to save.** While a profile's manager is a plugin or None, Ardia's offer to save is off for it; it comes back
when the profile returns to Ardia, unless you had turned it off yourself. `password-manager.json` in the data folder
records which profiles Ardia turned off, so the give-back survives a relaunch. Both directions are crash-safe: turning
off writes the record, then the pref; giving back clears the record, then turns the pref on, so a crash in between
leaves offer to save off and never overrides your own Off. A record write that fails while Ardia is taking a profile back is owed: it rides along with the next record
write that succeeds (so a relaunch keeps it) and is retried every 30 s, doubling to 5 minutes. If no write to
`password-manager.json` ever succeeds, the debt is lost at quit and offer to save stays off for that profile until you
turn it on yourself; each failure counts in `password_manager_record_failed`. A record from a newer Ardia (a higher
`version`) is never overwritten: offer to save is left as it is for that run.

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

### permissions

| Permission | What it allows |
| --- | --- |
| `tabs` | The helper may call `windows` and subscribe to tab, window and page events. URLs come without their query and fragment |
| `fullUrls` | Those URLs in full (needs `tabs`) |
| `commands` | The helper may run Ardia's commands, the same ones and with the same refusals as the `ardia` command (`docs/automation.md` › Which commands) |
| `network` | The helper may resolve names, connect to the internet and to servers on this Mac, and listen on any of this Mac's addresses. Without it, it can't connect, listen or accept connections at all, not even on this Mac |
| `control` | Install or Turn On turns on `cliControl`, the ardia command's control of Ardia; the sheet says "Lets any program you run drive your tabs and pages, with your logins" (for an always-on plugin, "… while it's installed. There's no off switch"). On macOS there's no switch afterwards: while an always-on plugin that asks for it is installed, each launch turns it back on, and the control pill's Stop holds only until the next launch. For an `autoInstall` built-in plugin, its first link turns it on once unless you'd turned it off. `config.json` can't set it. |

Contributions grant their own reach and are shown too: running a program, adding a page, adding commands, changing
named Ardia settings, offering tools, becoming a password manager.

## Turning a plugin on

A plugin you install is off. Turning it on in Settings › Plugins shows what it gets, in words built from the
manifest ("Runs a program in the background: /usr/bin/python3 helper.py", "Sees the address and title of your tabs",
"Runs Ardia commands", "Connects to the internet", "Changes these settings: commandBarStart", "Adds a page you open as a tab", …). Turn On approves that exact manifest in that exact folder: Ardia keeps the SHA-256 of the manifest's text and the
plugin folder's identity on disk (device and inode, after links) in `plugins.json`.

- **A changed manifest needs a new approval.** If `plugin.json` changes while the plugin is on, the plugin stops (its
  helper, page, commands, hooks and tools all go) and its row says it changed and asks you to review it. Settings
  defaults stay applied until you turn it off.
- Files beside the manifest (the helper's code, the page's files) aren't covered by the approval, like a hook's
  program in `hooks.json`: whoever can write your config folder can already change what Ardia runs. The approval is
  for the manifest's declarations, not for the code. A folder replaced on disk (`ardia plugins install --force` always
  installs a new folder, then swaps it in) is a new folder, so the plugin needs a new approval even with the same
  manifest and even when Ardia wasn't running; a running Ardia is also asked to turn it off first.
- Ardia reads the manifest and the folder's identity through one opened folder, never two lookups by name. Each
  helper start opens the folder again, checks that it is the approved one and that its `plugin.json` still hashes to
  the approval, and starts the helper in that opened folder; the page's files are served from the approved folder
  only. A folder swapped in between a scan and a start or a page load gets "changed since you approved it", not the
  old approval.
- `ardia plugins enable NAME` opens the same sheet in Ardia; it never turns a plugin on by itself.
  Nothing else turns one on: the dev harness can reach the plugin store only in a Debug build, never in a Release
  build that starts it for the perf probe.
- Turning off: the helper stops, its page tabs say it's off, commands, rows, hooks and tools go, and settings defaults
  go back.
- Remove (Settings, or `ardia plugins remove`) turns it off (if that can't be saved, nothing is removed), waits for its
  helper (and any run still stopping) to exit, then moves the folder to the Trash and deletes its
  `PluginData` folder and its page's website data. While it is being removed, the plugin can't be turned on. An instance on a scratch `ARDIA_DATA_DIR` deletes the folder
  instead, so tests never fill the Trash.

`plugins.json` (version 1): `{ "plugins": { "<name>": { "enabled", "approved" (manifest hash), "values" (row values),
"applied" ({ key: { value, previous, order, over } }) } } }`: `order` counts up as plugins are turned on, and
`over` names the plugin whose value `previous` was (null when it was yours), so whichever leaves, the defaults unwind
in the order they were applied and a value you set in between comes back. Turning a plugin on or off saves `plugins.json` first and changes
settings only once it is saved, so a failed save changes nothing.

## The helper

- **Starts** when the plugin is turned on, at launch for plugins that are on (after the first window), and when you
  press Restart. **Stops** when it is turned off, removed, its manifest changes, or Ardia quits: Ardia closes its
  channel, sends SIGTERM to the helper's processes and SIGKILL 3 s later (at quit, after 1 s). The run being stopped
  is retired the moment the stop is asked for, before its grace period: from then on Ardia takes no request from it,
  and work it queued earlier (an `open`, say) finds it gone and does nothing. While Ardia is quitting it takes no
  request from any helper; a cancelled quit takes them again. Starts, stops and removals of a plugin
  go through one queue, each to its end (the helper spawned, the folder deleted) before the next begins, and each first
  waits until every earlier run has exited, its grace period included, so two runs never overlap. Turning the plugin off
  or removing it cancels starts still waiting in the queue; stopping one particular old run doesn't. The helper's processes
  are found by responsibility: Ardia starts the helper as responsible for itself, so every process it starts, at
  any depth and whatever session or group it moves to (`setsid`, Node's `detached`, a double fork), names the helper
  as its responsible process while the helper runs. Ardia reads that set, with the helper's group and descendants and
  each process's start time, every time the helper starts another process, every second, and before it closes the
  helper's channel or signals it; every signal also reaches the descendants of every process seen before, even after
  the helper is gone. The group is signalled only while `waitid` confirms the helper is Ardia's own child and not yet
  reaped, so its id can't belong to anyone else. A helper may start other programs (the AI plugin runs the Claude
  Code CLI).
- **Supervised.** A helper that exits with a failure or a signal, or whose own process goes over `memoryMB` (a watchdog:
  its physical footprint checked every 10 s, not a hard cap, and its child processes aren't counted), is restarted after
  1, 2, 4, 8 then 16 s. After 5 failures within 10 minutes it stays stopped and its row says it crashed, with Restart.
  A helper that exits with status 0 isn't restarted. Every start, restart timer, call and page message belongs to one
  run of the helper; anything from an older run is ignored.
- **Launched** with `posix_spawn` in its own process group, from the plugin's folder, through
  `/usr/bin/sandbox-exec` with Ardia's fixed profile (`PluginSandbox.swift`), the paths passed as its parameters (`-D`),
  never written into the profile's text. It inherits nothing from Ardia but stdin (`/dev/null`), stdout and stderr (its
  log, `PluginData/<name>/plugin.log`, 0600, a regular file or the helper doesn't start, moved to `plugin.log.1` at start past 1 MB and emptied while it runs past
  2 MB) and the channel on descriptor 3; both ends of the channel are close-on-exec from the moment they exist. Its
  environment is only `PATH` (above), `HOME` (`PluginData/<name>/home`), `TMPDIR` (`PluginData/<name>/tmp`), `LANG`,
  `ARDIA_PLUGIN_NAME`, `ARDIA_PLUGIN_FD=3` and `ARDIA_PLUGIN_PROTOCOL=1`. A helper with `network` also gets the proxy
  settings Ardia itself was started with (`HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`, `ALL_PROXY` in either case), except a
  proxy whose address carries a user name or password, a query or a fragment (where a token could ride), which is dropped with one line in Ardia's log (an authenticated
  proxy is a follow-up the person would choose per plugin), and certificate settings that follow each tool's own
  meaning: `SSL_CERT_FILE` and `GIT_SSL_CAINFO` replace a tool's roots, so they point at
  `PluginData/<name>/certificates.pem` (the system roots plus the extra ones, only when the system roots could be read;
  otherwise they point at `/etc/ssl/cert.pem`); `NODE_EXTRA_CA_CERTS` adds to node's roots, so it points at
  `PluginData/<name>/extra-certificates.pem` (every distinct extra root, even one the system bundle also has, since
  node doesn't read the system bundle; only when there are any).
  The extra roots come from the files Ardia's own `SSL_CERT_FILE` or `NODE_EXTRA_CA_CERTS` name. The format is PEM
  with LF or CRLF line ends: only `-----BEGIN CERTIFICATE-----` blocks on lines of their own that each hold exactly one
  X.509 certificate are kept (`TRUSTED CERTIFICATE` blocks, a key labelled `CERTIFICATE`, trailing bytes, a block
  another marker interrupts or one that never ends is skipped), from regular files of at most 4 MB opened without
  blocking (a FIFO is refused), scanned line by line once. They are read on a background queue; before each start of a
  helper with `network`, each file's device, inode, size, and modification and status-change times are checked there, and a file that
  changed, was replaced or was deleted is read again (a failed read is never kept, and a root whose file is gone
  disappears, together with `extra-certificates.pem` when no extra roots are left). The start waits for that, up to
  3 s, then goes on on Ardia's plugin queue; past that it gets the system roots (`/etc/ssl/cert.pem`) directly. Preparations for the same settings share one read and different settings read apart, so a file stuck on a stalled
  disk holds up only the starts that need it, each until its own deadline, and a start still waiting when Ardia closes its plugins is cancelled, never launched. With no
  extra roots configured it gets them directly as well, and staged bundles are removed. The bundles are written through the already-open data folder, to a private file
  renamed into place. The Keychain's trust settings are out of the helper's reach, so a root kept only in the Keychain
  isn't trusted; `/etc/ssl/cert.pem` is a static bundle that macOS updates with the system, not your Keychain, and it is the
  default because it is the one system-wide root list every runtime can read. Never a token. A sandbox Ardia can't set up means the helper
  doesn't start; it never runs unsandboxed.
- **Data folder.** `PluginData/<name>` is opened once per start and must be a real folder Ardia's user owns, with
  `home` and `tmp` real folders in it; the log is created inside that opened folder, never through a link. The
  helper can write in it, so Ardia never follows anything the helper leaves there.
- **Sandbox.** It may read and write its `PluginData` folder and read the plugin's folder, the program it runs and that
  program's install folder (the folder above the `bin` it is in, so `/opt/homebrew/opt/node/bin/node` reads its own
  libraries; `/bin/sh` or `~/bin/x` read only themselves, since that folder would be `/` or your home, and so does a
  program on another disk or in another account's home, under `/Volumes` or `/Users`). Each folder between a protected
  root and the plugin's folder, its program or its data gets metadata reads (`PATH_UP_<n>`, metadata on named
  ancestors): stat and Finder info answer, listing and extended attributes don't. Your home
  folder, Ardia's data folder and its config folder are unreadable and unwritable, wherever they are (a scratch data
  folder outside your home included): your files, every browser profile, cookies, passwords and Ardia's own state. So
  are `/Users` (every account's home, `/Users/Shared` included) and `/Volumes` (mounted disks and disk images). The
  rest of the disk (system folders, `/tmp`, `/opt`) stays readable; a read allowlist is a follow-up. It
  can't connect to a Unix socket in your home or Ardia's data folder, so Ardia's control socket is out of reach. It
  can't write anywhere else on disk, nor create a Unix socket anywhere, nor connect to any but the system resolver's:
  its channel to Ardia is the inherited descriptor 3. Without `network` it can't connect anywhere, this Mac's own
  addresses included, and can't resolve names, listen or accept connections; with it, it reaches the internet and
  servers on this Mac, and a server it starts may listen on any of this Mac's addresses (the sandbox can't hold a
  listener to loopback: a listener under `(allow network-bind (local ip "localhost:*"))` still accepted a connection
  made from this Mac to its network address; connections from other devices weren't tested). A plugin whose
  folder (after links) would take in your home, Ardia's data or its settings, or whose program lives in Ardia's data or
  config folder, isn't started. The profile's grants are paths, the only kind `sandbox-exec` has: they name the
  approved folder's path at start. A folder put in its place afterwards can be read by the running helper instead
  of its own, and nothing outside the plugins folder can.
- **What else it refuses.** Launching apps or opening URLs (`lsopen`), Apple Events, creating launchd jobs, posting
  distributed or Darwin notifications, writing any preferences or reading any but the global domain, opening IOKit
  user clients, writing sysctls, POSIX shared memory beyond reading the preferences segments (`apple.cfprefs.*`) and the
  notification center's (`apple.shm.notification_center`), and looking up any
  system service off a short list: user and group lookups, logging, per-user temp folders, preference reads, and,
  with `network` only, the resolver, network settings and TLS trust (trustd fetches
  issuers over the network on a helper's behalf) (`PluginSandbox.machAllowed`, `machAllowedOnline`). Nothing it runs follows
  live changes to your locale or other global preferences: notification posts and lookups are refused, and nothing
  measured needed them. File events are refused too: fseventsd doesn't filter by the client's sandbox (a stream on `/`
  from inside showed writes in the home folder, live and in history replay, and gave out the device's event UUID;
  outside, streams on the home folder and relative to its device show them), so inside the UUID, the current and
  per-device event ids and every stream are refused,
  `fs.watch` fails and a runtime that needs it polls (the AI runtime's file watches do). It can't inspect or
  signal processes outside its own sandbox. `PluginSandboxEscapeTests.swift` proves each refusal next to a control
  outside the sandbox. Two controls are weaker: Apple Events only check that Finder runs (a real send would raise a
  privacy prompt), and sysctl writes are checked through the sandbox's own decision (`sandbox_check`), since the
  writable ones need root anyway.
- **What the sandbox doesn't do.** It runs as you, so it is a containment layer around a program you chose to run, not
  a defense against one built to escape. Known gaps: any same-user process's command line, and for a process without
  the hardened runtime its environment too, is readable (`KERN_PROCARGS2` can't be sandboxed), so nothing secret ever
  goes in a helper's arguments or environment, and Ardia's own launch never puts one there; files your config folder
  links to outside your home are readable; with `network`, a local server it starts may listen on any address; it isn't limited in CPU. Out of Ardia's reach: a
  process started within
  the moment between a helper's fork and its own exit. Checking a process id's start time and signalling it are two
  calls, so an id reused within microseconds in between could be hit. The responsibility calls
  (`responsibility_spawnattrs_setdisclaim`, `responsibility_get_pid_responsible_for_pid`) aren't public API: Ardia looks
  them up at runtime, and where they're missing it logs that and falls back to the group and descendants, which an
  orphaned or double-forked process escapes. Unverified until a signed, notarised build is tried: that notarisation
  accepts the lookup, and how macOS privacy prompts (TCC) attribute a helper that is responsible for itself; in a
  development build, prompts name the helper's program rather than Ardia. If Ardia crashes, a helper that doesn't exit when its channel closes keeps
  running until it is stopped by hand. So the permissions below are what Ardia hands a helper through its channel and
  what the sandbox holds it to on disk and on the network; the gaps above are outside them.

### The channel

Descriptor 3 is a Unix stream socket to Ardia speaking the control socket's protocol (`docs/automation.md` ›
Protocol: newline-delimited JSON, the same limits), private to this helper: nothing else can connect to it, and it
works whether or not "Let the ardia command control Ardia" is on. A helper should exit when it closes. A helper that
closes descriptor 3 itself but keeps running is still the plugin's running helper: it gets no calls, events or page
messages, its callers' tool calls fail at their deadline, and Restart (or exiting) starts it over.

Requests from the helper (`{"id", "method", "params"}`):

| Method | Needs | Result |
| --- | --- | --- |
| `hello` | | `{"app", "version", "protocol": 1, "plugin", "values"}`: `values` are the row values |
| `values` | | the row values |
| `subscribe` `{"events", "idle"?}` | the events in `hooks` | `{"ok": true}`; then `{"event", "time", "data"}` lines as on the socket; `["*"]` means every event in `hooks` |
| `windows` | `tabs` | as on the socket |
| `run` `{"command", "arg"?, "window"?, "tab"?}` | `commands` | as on the socket |
| `open` `{"urls", "activate"?}` | `commands` | opens 1 to 10 `http:` or `https:` URLs as background tabs in the last focused window (`activate` selects the first there without raising the window). Each URL, at most 2048 characters, is parsed whole as http or https with a host, before anything opens: the host as written must be ASCII (a Unicode name is refused; send it in punycode, `xn--`), with no user name or password and a port from 1 to 65535; an IPv6 host is put in its short form, and dotted IPv4 must have four parts. Raw spaces (percent-encode them), backslashes and control characters are refused before parsing. What opens is the normalised address: scheme and host lower-cased, the default port dropped, non-ASCII in the path, query and fragment percent-encoded as UTF-8, everything else as given. Anything else (`file:`, a path, `ardia:` or `chrome:` pages, `about:`, `javascript:`, `data:`, `ardia-plugin:`) is `bad_request`, and the message names the first bad entry, as in `urls[1] isn't a valid address`. It runs only while the run that asked is still the plugin's current run and still has `commands`; one queued behind other work when that stops opens nothing. Answers `{"ok": true, "tabs": [ids]}`: the tabs it made, nothing else |
| `page.post` `{"message", "view"?}` | a `page` | `{"ok": true}`, or `overloaded`: a message to the plugin's page views ([Pages and their helper](#pages-and-their-helper)); `refused` for a plugin with no page, however the method name is spelled in JSON |
| `page.open` `{"path"?, "split"?, "side"?, "context"?}` | a `page`; `context` needs `tabs` | `{"tabId", "windowId"}`: opens the plugin's page at that path in the last focused window, as a tab or in Split View beside the current tab |
| `tools.call` `{"plugin", "tool", "input"?}` | every permission the other plugin has | the tool's result, or its error; the plugin must be on and running. A plugin can't reach through another plugin's tools to what it wasn't granted itself |
| `result` `{"call", "result"? , "error"?}` | | `{"ok": true}`: the answer to a call (below) |

A method the manifest doesn't allow is `refused`. Page messages arrive as `{"pageMessage", "view"}`. Events from Ardia: `plugin.values` (`{"values"}`) when you change a
row, plus the subscribed events. Calls to a tool arrive as `{"call": "c4", "tool": "hello", "input": {…},
"caller": {"kind": "command" | "cli" | "plugin", "plugin"?}, "deadline": ms}`; the helper answers with `result`. A
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
folder, else the one the `ardia` command ships with (`ardia_cli/schemas/`); settings defaults need Ardia's
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

- `lib/pluginManifest.ts`: parsing, migration, checks and the schema; `lib/pluginManifest.test.mjs`.
- `state/site/passwordManager*.ts`, `verificationCodes.ts`: the `passwordManager` contribution's host side.
- `state/plugins/`: the registry (`store.ts`), saved state (`savedState.ts`), turning on and off (`lifecycle.ts`),
  settings defaults (`defaults.ts`), the helper channel (`channel.ts`, `channelMethods.ts`), tools (`tools.ts`),
  command bar entries (`commands.ts`), page tabs (`pages.ts`, `pageNames.ts`), consent copy (`consent.ts`), socket methods
  (`socketMethods.ts`).
- `platform/plugins.ts` binds `ArdiaPlugins` (`packages/shell/ios/PluginsModule.swift`, `PluginFolder.swift`,
  `PluginProcess.swift`, `PluginCore/` (`PluginSandbox`, `PluginFiles`, `PluginProcessTree`, `PluginRuns`, `PluginLifecycle`,
  `PluginPageMessages`, `PluginPageOutbox`, `PluginPageGate`, `PluginPageOffline`, `PluginPageData`; tested by `packages/shell/plugin-tests`, run by `swift test` in `packages/shell`, and `PluginPageData` in a fresh process by `scripts/pluginPageData.test.mjs`), `PluginPageView.swift`, `PluginSchemeHandler.swift`).
- UI: `components/settings/panes/Plugins.tsx`, `components/plugins/PluginPage.tsx` (rendered by `components/pages/InternalPage.tsx`).
- The example plugin used by the tests: `tests/fixtures/plugins/example/`.

## Telemetry

Counts only, never plugin names, titles, URLs, row values, tool input or output, each tied to the consent period the
activity began in (a tool call's outcome to the call, a helper start to the turn-on, restart or exit that asked for
it), so a count that finishes after sharing changed stays in the local copy:
`usage_counts.plugin_enables`, `plugin_disables`, `plugin_process_starts`, `plugin_process_crashes`,
`plugin_commands_run`, `plugin_tool_calls`, `plugin_tool_failures`, `plugin_page_opens`, `plugin_split_opens`,
`program_links`, `program_link_failures` (a link refused, a name taken or the copy failed), `program_unlinks`,
`program_adoptions` (an old `ardia` install's home taken over), `plugin_adoptions` (an always-on plugin installed on update because an old install was there); the daily settings snapshot's
`plugins_installed`, `plugins_enabled` and, among those on, how many use each contribution:
`plugins_with_settings`, `plugins_with_commands`, `plugins_with_page`, `plugins_with_process`, `plugins_with_programs`,
`plugins_with_hooks`, `plugins_with_tools`, `plugins_with_passwordManager`. Password managers: hourly
`password_manager_panel_opens_<badge|menu>`, `password_manager_panel_refused_<badge|menu>`, and each refusal's reason
`password_manager_panel_refusal_<hidden|not_focused|unavailable|not_key|not_editing|throttled|refused|no_panel>` (`no_panel`:
macOS took the request but no panel window was on screen 0.6 s later),
`password_manager_panel_hints_<shown|dismissed>` (the "Type <site> in Passwords to find this site" hint),
`verification_code_setups_<offered|accepted|failed>`, `password_manager_chose_<ardia|none|plugin>`,
`password_manager_record_failed`, and the daily `password_manager_profiles_<ardia|none|plugin>`. Dashboard: watch `plugin_process_crashes` against
`plugin_process_starts`, and `program_link_failures` against `program_links`.
