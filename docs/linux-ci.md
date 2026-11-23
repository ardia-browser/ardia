# Linux CI

Linux CI follows the Mac's prebuilt-engine model. Chromium is compiled only on a Linux builder. GitHub Actions fetches
a published, checksum-verified engine, builds the current `apps/linux` UI, packages it and smoke-tests the package.
Hosted CI never runs `gclient sync`, GN or a Chromium build.

## Pieces

| Piece | What it does |
| --- | --- |
| [`.github/workflows/linux.yml`](../.github/workflows/linux.yml) | Runs on pull requests and pushes to `main` that touch what the Linux build and its fixture suites read (not the Mac, iPhone, Android or Windows native code beyond the few files the parity fixtures compare against, which `scripts/ci/workflow-paths.test.mjs` checks), and by hand: a vouch `gate` job for pull requests from forks, then two `checks` jobs (the UI checks and the engine fixtures) and a `package` job on `ubuntu-24.04`. A pull request packages and smoke-tests the tarball alone unless it changes `scripts/linux`, the workflow or its setup action, or carries the `full-ci` label; pushes and manual runs also build, smoke-test and install the `.deb` and the AppImage |
| [`.github/actions/linux-setup`](../.github/actions/linux-setup/action.yml) | Ubuntu packages for the fixtures (clang, dbus, NSS tools, gnome-keyring, PyGObject), Node 24, pnpm and `pnpm install --frozen-lockfile` |
| [`scripts/linux/ci-checks.sh`](../scripts/linux/ci-checks.sh) | The engine-free checks. `--part ui` runs the `apps/linux` and `scripts/linux` checks side by side; `--part engine --shard I/N` runs every Nth Python suite and `engine/ardiacore-linux/tests` module, those in parallel, because the suite takes well over five minutes serially. With no options it runs everything |
| [`scripts/linux/publish-engine.sh`](../scripts/linux/publish-engine.sh) | Builder side: stages, strips and archives an engine from a Chromium out dir; `--upload` publishes it and adds its table row |
| [`packages/ardiacore/prebuilt-engines-linux.tsv`](../packages/ardiacore/prebuilt-engines-linux.tsv) | `key<TAB>tag<TAB>sha256` for each Linux engine published in ardia-browser/ardia, and a fourth field, the key it was published under, when that engine's sources are this key's (rows carried over when the key changed) |
| `packages/ardiacore/scripts/fetch-engine.sh --arch linux-x86_64` | Dispatches to [`scripts/linux/fetch-engine.sh`](../scripts/linux/fetch-engine.sh); the Mac path is unchanged |
| [`scripts/linux/runtime_files.py`](../scripts/linux/runtime_files.py) | The one runtime allowlist used by publishing, fetching and packaging, and the safe archive unpacker |
| [`scripts/linux/smoke.mjs`](../scripts/linux/smoke.mjs) | Strict smoke gate for a packaged tarball |
| [`scripts/linux/release.sh`](../scripts/linux/release.sh) | Builds a versioned Linux release with the CLI, smoke-tests it and prints the upload command; the Release workflow's `linux` job runs it |
| [`scripts/linux/linux_formats.py`](../scripts/linux/linux_formats.py) | Builds the `.deb` (its `Depends` read from the binaries) and the AppImage from package.py's staged tree |
| [`scripts/linux/deb-install-test.sh`](../scripts/linux/deb-install-test.sh) | Installs and purges a `.deb` in Debian 13 and Ubuntu 24.04 containers |
| [`scripts/linux/arch/`](../scripts/linux/arch) | The Arch package `ardia-bin`: PKGBUILD and `.SRCINFO`, `update-pkgbuild.sh` to point them at a release, `publish-aur.sh` to push them to the AUR |

## Engine archives

- **Key.** The engine is keyed by `engine/engine-key.sh --platform linux` (`engine/engine-key.py`), the Mac by
  `--platform macos`: one hash of every file the Linux build reads.
  - `engine/` without the `mac` lines of `engine/patches/series`, their patches and `engine/ardiacore`. The series is
    read with `engine/patches/series.py`'s own parser and validation, so the key and the build never disagree about a
    line (CRLF, comments, an unknown platform), and it counts as its lines for Linux: a new `mac` line changes nothing.
  - Without the translation units a `BUILD.gn` under `engine/` lists only inside `if (is_mac)`, such as
    `ac_external_apps.mm`. Headers there stay in both keys, since Linux code may include them.
  - Plus what `engine/ardiacore-linux/copies.tsv` lists (`<source><TAB><target>`, read by `apply.sh` and the key alike):
    a few `engine/ardiacore` headers, `packages/ardiacore/ios/page_script.js` and the logos.
  - Plus `apps/browser/assets/offline-game` and its pipeline, because the Linux build packs the offline game too
    (`game-resource.sh`).
  `engine/engine-key.sh --platform linux --paths` gives the git pathspecs of those inputs; uncommitted changes there
  stop the fetcher and the publisher, and a Mac-only edit doesn't.
- **Carried-over rows.** A row with a fourth field (`key<TAB>tag<TAB>sha256<TAB>built key`) serves an engine published
  under the built key: the fetcher downloads `ArdiaCore-<built key:12>-linux-x64.tar.xz` and checks its manifest names
  the built key. They map the engines published before the per-platform keys to the new keys of the commits they were
  built from, and the key after `copies.tsv` replaced the copies `apply.sh` spelled out to `engine-165962861895`: the
  old and new `apply.sh` write byte-identical trees.
- **Exact.** `scripts/linux/runtime_files.py serves --engine <dir> --key <key>` (used by `release.sh` and the `package`
  job) calls an engine dir this key's exact engine only when its `manifest.json` is format 2 for `linux`/`x64`, every
  required runtime file is a regular file (`locales` a directory), `chrome` is executable and matches the manifest's
  `chrome_sha256`, and the manifest names the key, or the key's row names the manifest's key as its built key. The
  row comes from the table (`--table`, default `ARDIACORE_PREBUILT_LINUX_TABLE`, else the checked-in one), and a row
  there that names another built key refuses the engine. With no row there, it is the row the fetcher verified: the
  second line of the cached engine's `.complete`, under the archive SHA-256, and it counts only for the cache folder
  named after its key and for the tag of its built key. So a row from the published table counts too, and the fetcher
  finds a cached engine again without its table.
- **Archive.** `ArdiaCore-<key12>-linux-x64.tar.xz` holds one directory, `ardiacore-linux-x64/`. It contains the
  allowlisted runtime files and a `manifest.json` (format 2): engine key, source commit, Chromium version, `args.gn` hash,
  chrome hash and build ID, and build and packaging times.
- **Where it's published.** It is attached to the `engine-<key12>` prerelease in ardia-browser/ardia, with a `.sha256`
  beside it; the Mac engine of the same key lives on the same prerelease. The scripts and workflows default to
  ardia-browser/ardia; `ARDIACORE_PREBUILT_REPO` (an environment variable, or a repository variable for the workflows)
  points them elsewhere. The engines published earlier on the contributor fork aren't used.
- **What it ships.** The allowlist ships only what Chromium loads at runtime. It leaves out `.so.TOC` files, the mock
  Vulkan driver, the Vulkan validation layer and `locales/*.pak.info`.
- **Stripping.** The publisher strips a staging copy. `chrome` shrinks from about 535 MB to about 300 MB, and the
  archive is about 110 MB.
- **Symbols.** Before stripping, the publisher keeps what each stripped file loses (`objcopy --only-keep-debug`) in
  `ArdiaCore-<key12>-linux-x64-symbols.tar.xz`, with its own `.sha256`, uploaded to the same prerelease. It holds
  `ardiacore-linux-x64-symbols/.build-id/<2>/<rest>.debug` per file, the layout gdb and debuginfod read, and a
  `symbols.json` naming each file's build ID. A `symbol_level=0` build has no debug info, so this is the symbol
  table: function names, no lines. Crash reports name `chrome` by its build ID (`crash_images`) and give each frame as
  an offset; [`scripts/linux/symbolize.py`](../scripts/linux/symbolize.py) names them:
  `scripts/linux/symbolize.py --symbols ArdiaCore-<key12>-linux-x64-symbols.tar.xz --build-id <id> <offset>...`
  (crashing frame first; the others are return addresses). The fetcher never downloads the symbols.
- **Source commit.** The publisher doesn't trust `repo.commit` alone. It computes the engine key of the source copy the
  with `engine/engine-key.sh --platform linux` over a scratch tree of it and records `source_commit` only when that
  commit's key matches.
- **Out dir.** The publisher copies from the out dir while holding the chromium lock and never writes there.

Publishing an engine for the current build:

```bash
source engine/patches/build/env.sh
scripts/linux/publish-engine.sh \
  --out "$CB/chromium_git/chromium/src/out/$GN_OUT_CONFIGS" \
  --source <the Ardia checkout the engine was built from> --upload
git add packages/ardiacore/prebuilt-engines-linux.tsv
```

Without `--upload` it only writes the archive and the symbols archive and prints the table row.

The fetcher checks an archive in this order:

1. it verifies the SHA-256 before unpacking;
2. it rejects entries outside `ardiacore-linux-x64/`, links pointing outside it, and special files;
3. it checks the manifest's engine key and platform;
4. it moves the engine into `apps/browser/build-ardiacore/prebuilt-linux-x86_64/<key12>/`, and marks it complete
   last.

It reads the local table first, then the cache, then the published table on `main`, so CI on an older commit still
finds engines published later.

## Nearest engine for CI, exact engine for releases

The key's paths change in many commits, and many of those changes are Mac-only. Requiring an exact engine would leave the
package job red after almost every merge.

- **Nearest.** The workflow defaults to `--nearest`, the same option the Mac fetcher has. It uses the engine of the nearest
  earlier commit that changed the key's paths, within the last 200 such commits. The job warns, the summary names
  both keys, and the artifact is named `Ardia-linux-x64-<commit12>-engine-<engine12>`.
- **Exact.** Choose `exact` when a package must match its source. A Linux release requires it, and
  `scripts/linux/release.sh` defaults to it.
- **Keeping nearest close.** Publishing after each change to the key's paths on the builder keeps nearest builds close.

## Jobs

- **`checks`.** It needs no engine. It runs:
  - the `apps/linux` typecheck, host, symbol, module-graph and acceptance self-tests;
  - the UI build;
  - the Python and Node suites under `engine/patches/build/tests`, `engine/chromium/src/chrome/browser/ardia/tests` and
    `engine/ardiacore-linux/tests`.

  On failure it uploads every check's log.
- **`package`.** In order, it:
  1. reads the version from `MARKETING_VERSION` in the Xcode project, as `scripts/release.sh` does;
  2. fetches the engine (cached per engine key and table);
  3. builds `apps/linux/dist`;
  4. fetches the `ardia` command pinned in `apps/browser/official-plugins.json` (its linux-x64 tarball, from
     ardia-browser/plugins' release, SHA-256 checked) and names it `ardia-cli-<version>-linux-x64.tar.gz` for the package
     (`scripts/release/official-plugins.py linux-cli`); until the pin is published it packages without the CLI, with a
     warning, and the smoke skips the `cli-*` assertions;
  5. prepares uBlock Origin with `scripts/linux/fetch-ubo.sh` (cached);
  6. runs `scripts/linux/package.py --out <engine> --version <version> --cli <CLI tarball> --deb <path> --appimage
     <path>`, which seeds the packaged uBlock Origin by running the staged `chrome` once (`scripts/linux/ubo-seed.mjs`);
  7. runs the smoke gate on the tarball, the `.deb` and the AppImage, with `--allow-old-engine` when the engine is a
     nearest one;
  8. installs the `.deb` with `scripts/linux/deb-install-test.sh` in Debian 13 and Ubuntu 24.04 containers
     (dependencies resolve, every library is found, `chrome-sandbox` is setuid root, the AppArmor profile only where
     the 4.0 ABI is, `apt purge` leaves nothing), about a minute; a failure fails the job;
  9. uploads the tarball, the `.deb`, the AppImage, their SHA-256 files and `results.json` for seven
     days.

  Its apt list covers the libraries `chrome` links (`readelf -d`) plus GTK and libsecret, which it loads at runtime.

The Ubuntu compatibility risk is small. The engine builds against Chromium's own sysroot (`use_sysroot=true`), and
`chrome` needs at most GLIBC 2.25.

## Smoke gate

`node scripts/linux/smoke.mjs --package <tar.xz|.deb|.AppImage> --results <dir>` unpacks the package (`tar`,
`dpkg-deb -x` or `--appimage-extract`) and launches its launcher:

- with headless Ozone and SwiftShader;
- with `ARDIA_BACKGROUND=1`;
- with a throwaway profile;
- without `--ardia-ui-dir`.

It refuses any sandbox-disabling switch. Every check must run and pass:

1. `ldd` resolves every library.
2. The `chrome://ardia/` shell renders, and its assets are byte-identical to the packaged UI.
3. The bootstrap reports `appBuild=linux-host`.
4. A native tab loads a local HTTP fixture, paints it, and the page cannot see `__ardiaHost`.
5. Every renderer runs under seccomp in its own user and pid namespace.
6. The shipped uBlock Origin and its Linux bridge are present and the content blocker reports ready.
7. A clean quit and relaunch restores the tab.
8. `install.sh --destdir` stages the launcher, desktop entry, chrome, UI and polkit policy with the right modes, plus
   `lib/ardia/VERSION` and `lib/ardia/cli/` when the package has them. For a `.deb` it checks the control file, the
   maintainer scripts, root ownership, the setuid `chrome-sandbox`, the policy and the AppArmor profile; for an
   AppImage the type 2 header, `AppRun` and that no setuid helper is inside.
9. `app-version`: `systemInfo.appVersion` is `lib/ardia/VERSION`.
10. `cli-install`: the bundled installer installs the bundled CLI the way the browser does
    (`--version <VERSION> --sha256 <digest>`, `ARDIA_CLI_URL=file://…`). `HOME`, `XDG_DATA_HOME`, `ARDIA_CLI_HOME` and
    `ARDIA_CLI_BIN_DIR` all point into the scratch folder. `ardia --version` must print the package version, and a
    second install must be a no-op.
11. `cli-control`: a third instance turns `cliControl` on. Then, with `--data-dir <profile>`, `ardia windows` must
    succeed, `ardia browse open <fixture>` (a background tab) then `get title` must read the fixture's title, and
    `ardia windows` must list that tab. Turning control off must make `ardia windows` exit 2. It doesn't use
    `open --show`: that switches Ardia to the tab, but on Linux the page can stay hidden, so the command fails (see
    [cli.md](cli.md) › Linux).
    The app doesn't start its token server when `--remote-debugging-port` is set, so this instance is driven over
    `--remote-debugging-pipe` instead.
12. `cli-scripts`: a fourth pipe-driven instance, with extensions on, turns `cliControl` on. `ardia scripts install`
    of a userscript that prefixes the fixture's title must report the profile `loaded`, `ardia scripts list` must show
    it as reported by Ardia, and the fixture opened with `ardia browse` must read retitled. After
    `ardia scripts uninstall` it must report `removed`, and the fixture must open with its own title.
13. `window-state`: in the first instance, `ArdiaShell.windowButtonLayout` must answer `{ layout, desktop }` (a string
    or `null`, and a string), `ArdiaShell.windowState` for the shell's own window three booleans (`maximized`, `tiled`,
    `fullScreen`), and `windowState` for an unknown window the error `No such native window`.

Checks 9 to 12 report `skip` and pass for a dev package without `VERSION` or `cli/`. Checks 9 to 13 can also report
`old` when the engine's host predates the feature: `appVersion` is Chromium's own version, the bootstrap advertises
none of `engine.setCliControl`, `ArdiaCli.install` and `ArdiaAutomation.start`, (for `cli-scripts`) not all four
`ArdiaUserScripts` methods, or (for `window-state`) neither `ArdiaShell.windowButtonLayout` nor
`ArdiaShell.windowState`; an engine that advertises only one of the two fails `window-state`. `old` fails the gate unless
`--allow-old-engine` is passed. CI and `release.sh` pass it only for an engine that isn't the commit's own.

It takes about 8 s without the CLI, and writes `results.json`, the launch logs and `cli.log`.

A headless smoke can't cover focus, GPU, keyring or desktop dialogs, and no automated check here does. The headless
acceptance suite ([linux-acceptance.md](linux-acceptance.md)) runs by hand.

## Linux releases

`scripts/linux/release.sh <version>` is the Linux half of a release (`docs/releasing.md` › Linux package). In order,
it:

1. checks the version's channel, `MARKETING_VERSION`, the notes file and a clean tree;
2. fetches the exact engine (`--engine nearest`, an engine dir or a Chromium out dir make test builds);
3. builds `apps/linux/dist`, the CLI and uBlock Origin;
4. packages `Ardia-<version>-linux-x64.tar.xz` with `--version` and `--cli`, and the same tree as
   `Ardia-<version>-linux-x64.deb` (which needs `dpkg-deb` and `readelf`) and `Ardia-<version>-linux-x64.AppImage`;
5. writes `ardia-bin-<version>.src.tar.gz`, the PKGBUILD and `.SRCINFO` pinned to that tarball by
   `scripts/linux/arch/update-pkgbuild.sh`;
6. writes the `.sha256` files and `provenance.txt` (version, channel, commit, engine key, Chromium version and the
   digests);
7. runs the smoke gate on the tarball, the `.deb` and the AppImage.

Everything goes to `dist/<version>/linux/`, or to `--out`. It never uploads. It prints the `gh release upload` command
for the tarball, the `.deb`, the AppImage, the Arch source package, the CLI tarball (the pinned command, renamed for
this version) and their `.sha256` files, and for
a stable the AUR update. `--allow-dirty` builds from a dirty tree for testing.
The key's paths must still be clean for a fetched engine, so pass an engine dir then.

The Release workflow (`release.yml`) runs it in its `linux` job, beside the Mac build, with `--engine exact`, runs
`deb-install-test.sh` on the `.deb`, and uploads the assets, their `.sha256` files and `provenance.txt` as the `linux`
artifact. When the install test fails (after apt's and the image pulls' retries), the job deletes the `.deb` and its
`.sha256`, adds a `deb dropped` line to `provenance.txt` and warns, and still succeeds: the tarball, AppImage, Arch
source package and CLI ship without it. Only a `deb dropped` line lets `publish.sh` go on without the `.deb`.
The `linux-sign` job, the only one that sees the `LINUX_UPDATE_ED_PRIVATE_KEY` secret, downloads that artifact and
signs `Ardia-<version>-linux-update.txt` with `scripts/linux/sign-update.mjs`, which refuses a key that doesn't match
`scripts/linux/linux-update.pem`; it uploads the manifest and its `.sig` as the `linux-update` artifact. When signing
fails, `publish` warns and the release ships without them, so installed Linux apps fall back to the release page for it.
`publish` puts that artifact in `dist/<version>/linux/`, and `publish.sh` attaches the assets to the GitHub release it
creates. It refuses a Linux folder whose provenance names an inexact engine or uncommitted changes. A dry run
publishes nothing. When the `linux` job fails, usually because the release's engine key has no published Linux
engine, the Mac release still ships: `publish` warns and the release has no Linux assets until someone builds them
with `release.sh` and uploads them by hand.

### The AUR

Every release carries `ardia-bin-<version>.src.tar.gz`, so Arch users can `makepkg -si` from the release page without
the AUR ([linux-port.md](linux-port.md#installing-on-linux)). The AUR itself follows stable releases only.

After a stable release publishes, the `aur` job moves `ardia-bin` on the AUR to it: `scripts/linux/arch/publish-aur.sh
<version> --sha256 <the tarball's digest>`, which checks the published tarball against that digest before it pushes,
and uploads the PKGBUILD and `.SRCINFO` it wrote as the `aur` artifact. It runs only when the `linux` and `publish`
jobs succeeded, and never for a nightly. It needs:

- the `AUR_SSH_PRIVATE_KEY` secret, the private half of an SSH key added to the AUR account that maintains
  `ardia-bin` (aur.archlinux.org › My Account › SSH Public Key). Without it the job warns, shows the commit and
  pushes nothing; run `publish-aur.sh` by hand then;
- optionally the `AUR_GIT_NAME` and `AUR_GIT_EMAIL` repository variables, the commit author on the AUR (default
  `github-actions[bot]`).

A dry run clones the AUR over HTTPS and shows the commit without pushing. The first real push creates the package.
The job has `continue-on-error`, so an AUR outage leaves the release run green; rerun it or run `publish-aur.sh` by
hand. The one-time setup is in [releasing.md](releasing.md#linux-package).

## Sandbox on Ubuntu

- **The restriction.** Ubuntu 24.04 limits unprivileged user namespaces through AppArmor
  (`kernel.apparmor_restrict_unprivileged_userns=1`). The engine builds `chrome_sandbox` and packages ship it as
  `chrome-sandbox`; `install.sh` (as root) and the `.deb` make it setuid root. The launcher decides before Chromium
  does ([linux-port.md](linux-port.md) › Packaging and installing).
- **In CI.** The workflow lifts the restriction on its throwaway runner before the smoke step and never passes
  `--no-sandbox`.
- **For users.** Users on Ubuntu 24.04 hit the same restriction. `sudo ./ardia/install.sh` installs and loads an
  AppArmor profile for the installed `chrome`, as Chrome's `.deb` does ([linux-port.md](linux-port.md) › Packaging
  and installing). An extracted tarball run in place says how to fix it and exits; an AppImage runs without the
  sandbox there and says so.

## Triggers and gating

- **When it runs.** On pull requests and pushes to `main` that touch what the Linux build reads: `apps/linux`,
  `apps/browser`, `plugins`, `packages`, `engine`, `scripts/linux`, `scripts/lib`, `scripts/agent/locked`,
  `infra/feedback/lib`, `patches`, the workspace manifests and lockfile, the Linux setup action and the workflow itself.
  Mac-only changes elsewhere skip it. It can still be started by hand, with `exact` to require this commit's engine.
- **Gate.** Like `ios.yml`, `android.yml`, `windows.yml` and `mac.yml`, a `gate` job runs `vouch.gate` first for a
  pull request from a fork, and both jobs need it. An unvouched author's pull request waits until a maintainer comments
  `vouch` or adds `run-ci`; `linux.yml` is in `GATED_WORKFLOWS` (`.github/vouch/vouch.cjs`), so that re-runs its
  skipped run. Pushes, manual runs and pull requests from a branch of this repository skip the gate and build at once:
  only people with write access push those branches, and the gate would only spend an `ubuntu-latest` slot to say so.
  A newer push cancels the run before it, on `main` too; manual runs are never cancelled.
- **Runner.** A `route` job picks `ubuntu-24.04` or, when GitHub's runners are busy, Boat CI's `boat-large` for
  `checks` and `package` ([ci-boat-overflow.md](ci-boat-overflow.md)). It is skipped for forks, and a skipped or failed
  route job keeps both on `ubuntu-24.04`.
- **No engine.** With no published engine for this commit's key or the 200 engine commits before it, `package` fails
  and says to publish one.
