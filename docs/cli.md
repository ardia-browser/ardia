# The `ardia` command

The `ardia` command drives a running Ardia from the terminal. It is its own project now: source, tests, CI, version
and releases live in github.com/ardia-browser/plugins (`plugins/cli`), and its manual is
[plugins/cli/docs/cli.md](https://github.com/ardia-browser/plugins/blob/main/plugins/cli/docs/cli.md) there. This page
is what Ardia does for it: how it ships, how it's installed, and the contract the two keep.

## How Ardia ships it

- **The pin.** `apps/browser/official-plugins.json` names each official plugin Ardia bundles: its version, the GitHub
  release it comes from and the SHA-256 of each artifact (`macos-arm64`, the plugin folder; `linux-x64`, the command's
  tarball; `installer`, `install.sh`). A `null` SHA-256 means not published yet, and every release step that needs it
  refuses. `scripts/release/official-plugins.py pin cli <version>` writes the hashes of a published release, and
  `check` (in the tests) holds the file well formed and `apps/cli/install.sh` equal to the pinned installer. The app's
  official catalogue (`state/plugins/official.ts`) is held equal to it by a test.
- **macOS.** The Release workflow's `build` job, which holds no secrets, fetches the pinned folder, checks its SHA-256 and
  unpacks it (`official-plugins.py bundle`: files and folders only, its `plugin.json` must be the pinned name and
  version). The `sign` job signs its Mach-Os inside out with the app's Developer ID and hardened runtime, writes each
  plugin's payload digest into `Info.plist` (`ArdiaBuiltInPlugins`) and the program registry its manifests' `claim`s and
  the pin's `legacyInstall` make (`ArdiaProgramRegistry`, `docs/plugins.md` › programs), then signs the app; `verify.sh`
  recomputes both on the signed app and checks every Mach-O's signature and runtime flag. The plugins repo never needs the
  signing identity. The release no longer publishes an `ardia-cli-*.tar.gz` of its own.
- **Linux** has no plugins yet, so the package carries the command for its installer: `official-plugins.py linux-cli
  <app version>` fetches the pinned linux-x64 tarball, checks it, and renames it `ardia-cli-<app version>-linux-x64.tar.gz`
  with that top folder, the name the Linux engine's installer (`ac_linux_cli.cc`) expects; `scripts/linux/package.py`
  puts it in `lib/ardia/cli/` with `apps/cli/install.sh` and its digest. The smoke's `cli-install` checks that the
  installed `ardia --version` prints a version (the command's own, not the app's).
- **`apps/cli/install.sh`** is the one file of the command kept here: the engine's Linux packaging test
  (`engine/patches/build/tests/test_linux_release.py`) reads it, and moving it would change the engine key. It is a copy
  of the pinned release's `install.sh`; when the engine is next rebuilt, that test can read the fetched installer and
  the copy can go.

## Installing it

On macOS it's the **Command Line** plugin (`docs/plugins.md` › Built-in plugins, › programs, › Official plugins): a
fresh profile is offered it in Settings › Plugins and onboarding, and one click installs it through the consent sheet.
Settings › Advanced › Command line has no switch on macOS: it's one line of status ("Not installed." with Open
Plugins, "On your PATH. It can control Ardia.", or why it isn't on PATH, with Try Again). Once installed it stays: Ardia keeps `~/.local/bin/ardia` linked to its copy in
`~/Library/Application Support/Ardia/Programs/cli/`, makes a new copy when the app brings a new version (checked against
the signed digest), and runs its after-update actions once per version (`ardia skills install --auto`,
`ardia skills refresh`, `ardia computer refresh`). **Installed means control is on**: installing turns `cliControl` on
(the sheet says so), and each launch turns it back on while Command Line is installed. The control pill's Stop turns
it off until the next launch. An install you approved moves to the version this Ardia pins by itself when the new version asks
for nothing you hadn't approved (`docs/plugins.md` › Official plugins, #3868), and Command Line's page in Settings ›
Plugins then says "Updated by itself" and lists what's new. Python 0.4.0 to Bun 0.6.0 is such a move, and so is any later
pin with the same surface: the same control and `ardia` with the same after-update steps, plus a sandboxed, offline
`main` that first starts from the Show Status command. Its note says it added that code. The 0.4.0 daemon keeps running
beside the new one until Ardia quits (#3472). An `ardia` installed the old way (`~/Library/Application Support/Ardia/CLI/current`) that was never approved
in Ardia isn't adopted by itself: there's no approval to compare with. It stays on PATH, untouched, and Command Line
shows as available, its row in Settings › Plugins saying "An older ardia is installed. Install Command Line to update
it." Installing it moves the link to the new copy and points `CLI/current` into the store, so paths saved through it
keep working (`usage_counts.plugin_adoptions_waiting` counts these). There's no uninstall from
Settings; removing the link brings it back at the next launch.

On Linux, Settings › Advanced › Command line installs it from the package (`install.sh --version <app version> --sha256
<digest>` with a `file://` URL), as before.

`cliControl` (`state/app/cliControl.ts`) stays the stored key, the control pill stays in the app, and on Linux and in
older data folders it means what it always did; Linux keeps its switch in Settings › Advanced. While it is on, `ardia`
reaches Ardia two ways (`docs/automation.md`, `docs/control-socket.md`):
- **The control socket** (`ArdiaControl.sock`, mode 0600) carries the owner's methods. It has no token: the server
  checks that the peer runs as the same user (`getpeereid`) and, on macOS, who the program is: a hardened program
  signed with Ardia's Team ID (the bundled `ardia` and anything else Ardia ships) gets in at once, and any other
  program waits for you to allow it in the doorbell Ardia shows (`docs/automation.md` › Who the program is). Linux and test instances admit every process of the user.
- **The engine's token connection** carries `ardia browse`. It listens on loopback with a token the command asks
  the control socket for (on Linux, where the socket has no doorbell, it reads it from `ArdiaControl.json`, which
  the user's own processes can read). It is a full DevTools client of the browser, the same
  as a `--remote-debugging-port` client (the owner's decision, #2807): every CDP domain and method, every target
  (`chrome://` and WebUI pages, extension pages, service workers, the browser target), every URL and browser context,
  and local files, so `ardia browse upload` (`DOM.setFileInputFiles`), `download` and `wait --download`
  (`Browser.setDownloadBehavior`), emulation on any tab, cookies, storage, request interception, screencasts and the
  debugger all work. Events and replies pass through unchanged.

  The control socket's `control.devtoolsEndpoint` hands out the port and token, only to programs the socket admitted
  (the doorbell's rule, `docs/control-socket.md` › The DevTools token). The command asks there first (ardia-browser/plugins#112),
  falling back to `ArdiaControl.json` only on an `unknown_method` reply to that request or when it can't reach the
  socket. On macOS the engine no longer writes the token into the file, so the file doesn't let a program skip the
  doorbell.

  What still guards it is what keeps other users and web pages off the connection, not what a process running as
  you may do: the token (32 random bytes per start, compared in constant time, kept in the 0600 `ArdiaControl.json` on Linux only, and handed by
  the control socket's `control.devtoolsEndpoint` to programs it admitted, which keep it until the token connection
  restarts),
  loopback only, and nothing a browser sends: a request with an `Origin`, `Sec-Fetch-Site` or `Sec-Fetch-Dest` header, or
  a `Host` other than `127.0.0.1:<port>` or `localhost:<port>`, is refused before the token is read. So no web page,
  extension page, service worker or DNS-rebound name in a browser that sends Fetch Metadata (Chromium, Firefox 90 and
  later, Safari 16.4 and later) can open the socket or ask `/ardia/active`, even holding the token; a top-level GET from
  an older Safari still needs the token and can't read the answer. Then the `RemoteDebuggingAllowed` policy, and a data
  folder only you can write to: the engine opens the folder once, checks it belongs to you, that no one else can write
  to it, that no macOS access list lets anyone else in, that its disk doesn't ignore ownership, and on Linux that it isn't a mount that skips permission checks for other users (FUSE `allow_other` without `default_permissions`, SMB `noperm`), and creates, checks
  (0600, owned by you, any inherited macOS ACL removed) and renames the file through that same open folder, so a folder
  swapped meanwhile is never written to. The
  engine also keeps its bookkeeping: a command must be a JSON object with an integer `id` and a string `method`
  (`params`, if present, an object; `sessionId` naming a session this connection attached), one command per
  (session, id) until its reply, and at most 4096 waiting replies before the connection is closed. Showing a saved
  password still asks for your Mac's login, as it does in the Passwords page, since that check runs in the browser,
  not in DevTools. Plugin helpers can't read `ArdiaControl.json`: their sandbox denies the app's data folder and
  LaunchServices (`docs/plugins.md`, #2857).

  The engine records which tabs the command opened (`Target.createTarget`) for `ardia browse set viewport`'s
  off-screen move and marks off-screen targets `ardiaOffscreen: true` in `Target.getTargets` and
  `Target.getTargetInfo`. It never closes a tab on its own: off-screen tabs are closed by the app, through ArdiaCore's
  normal close, 5 s after the last connection ends (`state/automation/offscreen.ts`). `ac_cli_control`'s status
  counts commands by domain (`tokenCommands`), sent as `usage_counts.cli_cdp_commands_<domain>`.

## The contract

- **Control protocol.** `hello` carries a protocol number both ways. Ardia answers with `protocol` (today 4) and
  `minClientProtocol`, and refuses a `hello` that names an older `protocol` with `unsupported_protocol` ("… update the
  command"); a `hello` with no `protocol` is taken as the current one, as every command before this change sent none.
  The command sends its `protocol` and refuses an Ardia whose `protocol` is under its `MIN_APP_PROTOCOL` ("… update
  Ardia"), before it sends anything else. A side raises its minimum only when it needs the other's newer behaviour, so a
  newer command against an older Ardia, or the reverse, either works or says which one to update. `ardia --version`
  reports the command's own version.
- **Methods.** `methods` lists every method the socket answers: `name`, `area`, `mutates`, `description`, `params` (a
  JSON Schema subset the socket checks before it runs anything) and `result`. The command's `ardia methods` prints it
  and `ardia call <method> [params]` calls any method, so a method Ardia adds is usable from the shell without a new
  command release. Adding methods doesn't change the protocol: a command that calls one an older Ardia lacks gets
  `unknown_method`. Every area, what it reads and changes, and what stays out of reach (passwords, card numbers,
  cookie values) is in `docs/control-socket.md`. Tile folders (`pins.*`), page icons (`favicons.get`), shared
  and live folders (`sharedFolders.*`, `live.*`), setup codes (`presets.*`) and Air Traffic Control rules
  (`airTraffic.*`) are there too.
- **One line is at most 1 MiB.** Every line Ardia writes on the socket (a reply, an event, a decide request) is at most
  1 MiB (1,048,576 bytes, newline included), the limit every shipped command reads (`MAX_LINE` in `control.py` and
  `control.rs`); a longer line makes the command drop the connection. Old commands can't change, so Ardia keeps to it:
  pages stop early, a read whose reply wouldn't fit answers `failed` saying what to narrow, a write whose result wouldn't
  fit answers a compact `{ok, oversized, …counts}` so it's never unclear whether the write happened, an event that
  wouldn't fit goes out summarized with `truncated: true`, and a decide request that wouldn't fit isn't sent (Ardia uses
  its default). A reader that falls behind loses its oldest events, never a reply or a decide message and never its connection
  in the middle of a line; the next event it gets carries `dropped: <n>`. Details in `docs/control-socket.md` › The 1 MiB line.
- **The plugin schema.** `docs/plugin.schema.json` is the manifest schema Ardia writes (`apps/browser/scripts/
  write-plugin-schema.mjs`; a test keeps it current). The command ships a copy for `ardia plugins check` offline, and the
  plugins repo's CI compares that copy with ardia main's.
- **Release smoke.** `scripts/release/cli-bootstrap-smoke.sh` checks that a fresh profile gets no `ardia` until it installs
  Command Line, and that an installed one gets `ardia` from the signed copy at the pinned version with `ardia tabs`
  answering. `scripts/release/token-smoke.sh` runs `ardia browse` over the real token connection with the app's built-in
  `ardia`.
- **Telemetry.** The command's events go to the same service under `source = 'ardia-cli'` (the dashboard's CLI health
  page reads them); the What's Sent copy in the app lists them, since the consent is the app's. A new CLI event needs
  that copy changed here.
