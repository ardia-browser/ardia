# Building the engine for Windows

The Windows engine is the same tree as the Mac's (`docs/engine-build.md`): **Chromium 158.0.8127.36**, **Helium**
0.22.1 (helium-chromium) with **helium-windows** 0.22.1.1 in place of helium-macos, then our patch series. It is
cross-built on a **Linux host**, a Boat VM ([On a Linux host](#on-a-linux-host)): Linux is Chromium's supported host for
Windows cross builds (`docs/win_cross.md` in the tree). The same scripts still run on a Mac, where the first engines were
built, but **never build a Windows engine on the owner's Mac** (the owner's rule since 2026-11-15: a cross build pins
every core of the machine they work on). No Windows machine is needed, not even for the toolchain.

The scripts are in `scripts/windows/engine/`, not next to the Mac ones: nothing for Windows may live under `engine/`,
because `engine/engine-key.sh` hashes what is under `engine/` into the keys the Mac and Linux prebuilt engines are
fetched under, so a new file there would make Mac or Linux builds miss their prebuilt engine. Windows-only patches go in
`scripts/windows/engine/patches/` and their order in `scripts/windows/engine/series-win`. The scripts source the Mac's
`engine/patches/build/env.sh` through their own `env.sh` and call its `step-guard.sh`, `gn_defines.sh`,
`03-helium.py` and `game-resource.sh`; they change nothing the Mac scripts do. Everything lives in `~/chromium-build-win`
(`AC_CHROMIUM_BUILD`, which every Windows script defaults to); the Mac's `~/chromium-build` is never touched.

**State on 2026-11-10/11 (MacBook Pro, M5 Pro, 24 GB).** Proven: the toolchain zip is accepted by the cross build,
Helium and our series apply, `gn gen` passes, and `base_unittests.exe` and `chrome` link. `chrome.exe` (3.1 MB) and
`chrome.dll` (332 MB) are PE32+ x86-64; the output has 525 runtime files (472 MB of `.exe` and `.dll`), and
`helium-check-build.py`, run against `chrome.dll` and the paks, finds no Helium uBlock Origin, onboarding page, non-free
search data or Helium hosts (703,485 resources in 232 paks; 8 still say "Helium"). It runs: the app is hosted in it on
x64 and ARM64 (`docs/windows.md`, The engine in the app), and CI launches both from the published packages. The exe's product
name is "Chromium", as the Mac framework's is (`chromium-branding.patch`). Not built yet: the official configuration (below). The Windows side of
ArdiaCore is `//ardia/win` (`scripts/windows/engine/src/ardia/win`), not the Mac's `engine/ardiacore`. Packaged: `ardia-chromium-win-x64.zip` ([Packaging](#packaging)). ARM64 (for Windows on
ARM, where x64 runs emulated): `gn gen` passes and `chrome` was at 51,230 of 54,203 steps with no failures when the 2026-11-11 run ended at
02:37 IST, left running with its packaging queued behind it ([ARM64](#arm64)).

## Steps

Run them in the order 1, toolchain, 1 again (its hooks), 3, 4, 2, 5, 6. Run each with stdin closed (`< /dev/null`): gclient and CIPD can wait on a prompt otherwise. Each needs `--apply` and the chromium lock
(on Linux `flock $AC_LOCK_ROOT/ac-chromium.lockf <step> --apply`, on a Mac `lockf -k …`). Step 3 needs the pinned
Helium checkouts in `$AC_CHROMIUM_BUILD/helium` and `$AC_CHROMIUM_BUILD/helium-windows` ([On a Linux host](#on-a-linux-host)).
The times below are the first Mac build's; the Linux VM's are in its section.

| Step | Script | What it does | Time (M5 Pro, 2026-11-10) |
|---|---|---|---|
| 1 | `01-sync.sh` | Clones and bootstraps depot_tools if missing, writes `.gclient` with `target_os = ['win']` and `target_os_only = True` (else gclient adds the host, `mac`, and fetches the Mac target's deps too), fetches Chromium's tag at depth 1, `gclient sync --no-history` of its git and GCS deps, `cipd ensure` of `cipd.ensure` (below), then the hooks. The `win_toolchain` hook fails until the toolchain exists | first run about 2 h on a mobile link that swung between 60 KB/s and 15 MB/s; 19 min for the last pass (deps on disk, CIPD and hooks) |
| toolchain | `toolchain.sh` | Downloads Visual Studio 2026's C++ tools and Windows SDK 10.0.28000 from Microsoft, packs them as `package_from_installed.py` would, writes the two variables the hooks need | download 20 min (1.6 GB), pack under a minute |
| 3 | `03-helium.py` | The Mac step 3 with helium-windows (below) | 2 min 51 s |
| 4 | `04-series.sh` | Our patches (below), `engine/chromium`, ArdiaCore's hook headers, the offline game | 6 s |
| 2 | `02-gn-args.sh` | `out/Release_GN_win_$WIN_CPU/args.gn` from `gn_defines.sh` (`WIN_CPU` `x64`, the default, or `arm64`), then `gn gen` | 7 s (38,372 targets; arm64 39,189) |
| 5 | `05-build.sh` | `autoninja` on `TARGETS` (default `base_unittests`) with `JOBS` local jobs (default 8); for `chrome`, Blink's bindings generators first at `BINDINGS_JOBS` (default 3) | `base_unittests`: 3 min (7,852 steps); `chrome`: about 2 h from the first start (90,670 steps), 35 min of it lost to swap before the job count came down; the last pass at 16 jobs compiled 31,000 steps in 52 min, and `chrome.dll` links in about 25 s (not an official build: no ThinLTO) |
| 6 | `06-package.sh` | `ardia-chromium-win-$WIN_CPU.zip` and `SHA256SUMS` in `~/ardia-windows/out` ([Packaging](#packaging)) | under a minute |

Disk: 52 GB in `~/chromium-build-win`: the checkout 42 GB with its 9.5 GB out dir, `win-toolchain/` 8.4 GB (the unpacked download 4.3 GB and the zip 4.4 GB; the toolchain unpacked in the tree's depot_tools is in the checkout's share).

**CIPD packages.** `cipd.ensure` lists the 11 a build uses, at this Chromium's DEPS versions: gn, ninja, siso, the host
Python, esbuild and TypeScript (DevTools and WebUI), 7-Zip, Go for the Mac host (Dawn's Tint generates sources with
it), the D3D12 Agility SDK, WebView2 and WTL. The other ~40 a Windows checkout asks for are test data, the updater's
and enterprise companion's prebuilt binaries, screen-ai, Apache, Go for other hosts, luci tools; on a slow link they
took hours. When the Chromium version moves, take the new versions from a full `gclient sync`'s ensure file (or DEPS).

## On a Linux host

Windows engines are built on an `xlarge` Boat VM (16 vCPU, 32 GB, 294 GB, Ubuntu 24.04) created with `--ttl 21600`
and Boat's built-in auto-stop left enabled (never `--no-auto-stop`), or resumed from a saved builder snapshot and
stopped as soon as the engine is published. x64 and arm64 each need their own tree (about 85 GB with one out dir), so
to build both at once take a second `xlarge` VM with `--ttl 21600 --no-snapshots` for the other CPU and delete it
once the engine is published. Nothing from Microsoft's packages leaves the VM except inside the built engine.

Once per VM:

```
sudo apt-get install -y msitools librsvg2-bin python3-pil git curl unzip zip patch fuse3
git clone https://github.com/ardia-browser/ardia.git ~/winengine/repo   # at the commit to build
export AC_CHROMIUM_BUILD=~/chromium-build-win AC_LOCK_ROOT=~/winengine/lock WIN_CPU=x64   # or arm64
E=~/winengine/repo/scripts/windows/engine
for repo in helium-chromium:helium helium-windows:helium-windows; do
  section=${repo%%:*} dir=$AC_CHROMIUM_BUILD/${repo##*:}
  url=$(awk -F' *= *' -v s="[$section]" '/^\[/{c=$0} c==s && $1=="url"{print $2}' $E/helium-pins.ini)
  commit=$(awk -F' *= *' -v s="[$section]" '/^\[/{c=$0} c==s && $1=="commit"{print $2}' $E/helium-pins.ini)
  git init -q $dir; git -C $dir fetch -q --depth=1 $url $commit; git -C $dir checkout -q --detach FETCH_HEAD
done
```

Then the steps in their order, each as `flock $AC_LOCK_ROOT/ac-chromium.lockf $E/<step> --apply < /dev/null`, and for
step 5 `TARGETS=chrome JOBS=16 BINDINGS_JOBS=4`. `/dev/fuse` must exist: on Linux the `win_toolchain` hook mounts the
unpacked toolchain through Chromium's `ciopfs` (case-insensitive), because the SDK's includes are written with the case
Windows ignores.

What differs from a Mac host, all in the scripts:

| Where | On Linux |
|---|---|
| `01-sync.sh` | The standard checkout: `target_os = ['win']` without `target_os_only`, so gclient adds the host and the Linux sysroots and host tools come with it, and every CIPD package DEPS lists (no `cipd.ensure`: a datacenter link takes them in minutes). After the hooks, the 30 hard-linked files of the two Debian sysroots get their own copies: the tree guard (`pathguard.py`) refuses hard links in any tree but the real `~/chromium-build` |
| `toolchain.sh` | Asks for msitools (`msiextract`) instead of running brew |
| `package_toolchain.py` | Looks files up without regard to case: msvc-wine unpacks `VC/Redist` and friends in Microsoft's mixed case, which only matched `VC/redist` on a Mac's case-insensitive disk |
| `env.sh` | `AC_TARGET_OS=mac`: since the Linux port, the shared `env.sh`, `gn_defines.sh` and `series.py` pick their target from the host, and Linux's would give Windows the Linux GN args (`enable_cdm_storage_id=false`, `enable_rlz=false`, `use_vaapi` …) and a Linux series base. `mac` is the flavor every Windows build has used; `gn_defines.sh` replaces its `target_os` and `target_cpu` |
| `03-helium.py` | Passes `--platform mac` to the shared step (one platform repo, helium-windows as `--helium-macos`), which otherwise takes helium-linux and its skips on a Linux host. Icons are made with `rsvg-convert` and Pillow (Ubuntu's ImageMagick 6 has no `magick`) |
| `02-gn-args.sh` | Reads link counts with GNU `stat` |
| `05-build.sh`, `01-sync.sh` | Raise the open-file limit `ciopfs` runs with (it inherits 1024 otherwise, and 16 compiles ran out) |
| `package_win.py` | Matches the archive config's names to the built files without regard to case |

The Windows pins (`helium-pins.ini` here) are the Windows build's own: the Mac moved to Chromium .50 and Helium 0.21.2
on 2026-11-12 while the Windows engine stays on 0.21.1, so `03-helium.py` no longer requires the two to match. Its guard
stage still fails on a shared skip the Windows series lacks.

The toolchain made on Linux is MSVC **14.52.37025** with SDK 10.0.28000 (hash `44da279f35`, 4.58 GB in 9,901 files):
Visual Studio's channel no longer offers 14.51.36231, the Mac's. Chromium's clang-cl takes only its headers and
libraries.

Times on 2026-11-16 (xlarge VMs, `windows-engine-20261116-10` to `-13`): step 1 6 min (the whole checkout and every CIPD
package), the toolchain 2 min (download and pack), step 1 again 2 to 6 min, step 3 2 min, steps 4 and 2 under a
minute, step 5 at `JOBS=16` about 85 min for x64 (78,800 steps) and 2 h 40 min for arm64 on a VM of its own, step 6
20 s. The first pass lost 57 x64 and 37 arm64 compiles to "Too many open files": `ciopfs` had inherited a limit of
1024 open files, which `01-sync.sh` and `05-build.sh` now raise. Load stayed at 17 with 13 GB of 32 GB in use, so
`JOBS=20` would fit. Disk: about 85 GB per VM with one out dir.

**ARM64 from a Linux host is broken (2026-11-16).** The arm64 engines built on the Linux VM (`windows-engine-20261116-10`
to `-13`) crash at start on CI's `windows-11-arm` runner, while the Mac-built `-4` runs: plain `chrome.exe --headless=new
--dump-dom` of a `data:` page hangs and Crashpad writes two dumps, every one an access violation reading `<cage>+0x80808083`
at `chrome.dll+0x2013db0`, with or without the sandbox, `--jitless` or the GPU. x64 from the same VM is fine. The likely
cause is V8's snapshot: an x64 Linux host builds `mksnapshot` for arm64 under V8's simulator (`clang_x64_v8_arm64`,
`snapshot_toolchain.gni`), where an arm64 Mac builds it natively; the two `snapshot_blob.bin` differ in 9,898 bytes.
Until that is fixed, build the arm64 engine where `mksnapshot` runs natively on arm64, and run any new arm64 engine on
the `windows-11-arm` runner before pinning it.

`06-package.sh` on Linux: Chromium's archive config says `D3DCompiler_47.dll`, the build writes `d3dcompiler_47.dll`,
and `make_zip.py`'s glob only ignores case on a Mac, so `package_win.py` rewrites each plain name to the built one
first (252 files, as from a Mac).

## The toolchain

`build/vs_toolchain.py` at this Chromium wants the package Google calls `3bfcb536c8` (`TOOLCHAIN_HASH`): Visual
Studio 2026 (18) with Windows SDK **10.0.28000** (`SDK_VERSION`; `setup_toolchain.py` checks the same). Outside Google
that package isn't downloadable, so a cross build supplies its own zip: `DEPOT_TOOLS_WIN_TOOLCHAIN_BASE_URL` names a
directory holding `<hash>.zip`, and `GYP_MSVS_HASH_3bfcb536c8=<hash>` maps Chromium's package to ours. The `win_toolchain`
hook (`vs_toolchain.py update --force`, then depot_tools' `get_toolchain_if_necessary.py`) unpacks it into
`depot_tools/win_toolchain/vs_files/<hash>` and checks the hash of the unpacked files.

`toolchain.sh` makes that zip with no Windows machine:

1. [msvc-wine](https://github.com/mstorsjo/msvc-wine)'s `vsdownload.py` (pinned at `fe512cf`) reads Visual Studio's
   own channel manifest (18.11.3 tonight) and downloads the packages straight from Microsoft's servers, accepting
   Microsoft's licence: MSVC 14.51.36231 (toolset v145) for x64, x86 and arm64 with ATL and the DIA SDK, and the
   `Win11SDK_10.0.28000` package (its MSIs unpacked with `msiextract`, from Homebrew's `msitools`). `--skip-patch`
   keeps Microsoft's headers unmodified. 1.6 GB downloaded, 4.3 GB unpacked, in `win-toolchain/msvc`.
2. `package_toolchain.py` lays the files out as `package_from_installed.py` does on Windows: `VC/Tools/MSVC/<ver>`
   (`bin`, `include`, `lib`, `atlmfc`, `crt`), `VC/redist`, `DIA SDK`, `Windows Kits/10` with only 10.0.28000's
   `Include`, `Lib`, `Source` and `bin`, the `sys32`/`sys64`/`sysarm64` runtimes and the UCRT DLLs, `VS_VERSION`
   ("2026"), and the `SetEnv.*.json` files, generated by depot_tools' own `GenerateSetEnvCmd`. It names the zip for
   the hash `get_toolchain_if_necessary.py` will compute (`CalculateHash`, first 10 characters). Tonight's:
   `5692d64547.zip`, 4.43 GB in 9913 files, stored uncompressed (it never leaves the machine).
3. It writes `win-toolchain/env.sh`, which `env.sh` sources:
   `DEPOT_TOOLS_WIN_TOOLCHAIN_BASE_URL=~/chromium-build-win/win-toolchain/zips` and
   `GYP_MSVS_HASH_3bfcb536c8=5692d64547`.

**Debuggers.** The SDK inside Visual Studio's packages has no "Debugging Tools for Windows", and `vs_toolchain.py`
copies `Windows Kits/10/Debuggers/<cpu>/dbghelp.dll` into every out dir (Chrome uses it to symbolize stacks); `gn gen`
fails without it. Microsoft also ships the debugger engine as the NuGet package `Microsoft.Debugging.Platform.DbgEng`
(`DBGENG_VERSION` in `env.sh`, 20260319.1511.0; Windows SDK licence), with `dbghelp.dll` and `dbgcore.dll` for x64, x86
and arm64. `toolchain.sh` now passes it to `package_toolchain.py --debuggers-from`, so a new zip has real debuggers for
every CPU (tested: hash `c6f0639b26`).

Tonight's zip, `5692d64547`, predates that: it has the SDK's own x64 `DbgHelp.dll` (from its App Certification Kit) as
`Debuggers/x64/dbghelp.dll`, and no arm64 or x86 ones. Repacking it changes the toolchain hash, which is in every
compile command (`/winsysroot:…/vs_files/<hash>`), so it would rebuild everything. Instead, `debuggers.sh` adds the
package's arm64 and x86 DLLs to the unpacked toolchain. `gclient runhooks` notices the changed files and unpacks the
zip again, which undoes that: run `debuggers.sh` after the hooks, or move to a new zip when a full rebuild is due
anyway.

macOS's file system is case-insensitive, so the SDK's mixed-case includes resolve as on Windows; Linux needs a
`ciopfs` mount for that, a Mac doesn't.

The fallback, packaging on a GitHub Windows runner with `package_from_installed.py`, wasn't needed. If it ever is,
the zip may only leave the runner encrypted to a key whose private half stays on the build machine: Microsoft's files
must not be published, and the repo is public.

## Helium for Windows

helium-windows 0.22.1.1 (`8a04093`) is Helium's Windows packaging for 0.22.1; its `helium-chromium` submodule is exactly
the 0.22.1 tag we pin (`1bccd2b`). Under 0.21.1.1 (`d6806de`) the submodule sat one commit past the tag (`42da6c5`, only `devutils/set_quilt_vars`), so
the patches are the same. `helium-pins.ini` pins both. Over helium-chromium's series it adds:

- ungoogled-chromium's Windows patches: build fixes (`windows-fix-*`, `windows-disable-reorder-fix-linking`,
  `windows-compile-mini-installer`), no RLZ in the installer, no event log, no machine id, no download-warning prompt,
  and checks against `third_party/win_build_output` turned into copies (only on a Windows host: a Mac host
  copies the checked-in MIDL and message-compiler outputs anyway);
- Helium's Windows branding, versioning, setup migration, the elevation service in the installer, SwiftShader behind
  its build flag, PlayReady support;
- WinSparkle as Helium's updater, and its remote build setup.

`03-helium.py` runs the Mac's `03-helium.py` (imported, so the stages, the guard, the omitted downloads and the
substitutions are the same code) with helium-windows for helium-macos. The Mac's skips of helium-macos patches are
left out; the skips of helium-chromium patches stay, and these are added (`WINDOWS_SKIP`):

| Patch | Why |
|---|---|
| `ungoogled-chromium/windows/windows-disable-encryption` | a `--disable-encryption` switch that stores cookies and passwords unencrypted |
| `helium/windows/updater/*` (8 patches) | WinSparkle; the app has its own updater |
| `helium/windows/rbe-linux-workers` | Helium's remote build setup |

The guard also watches Windows' key storage (`os_crypt`, `DPAPI`, `app_bound`, `elevation_service`). Its reviewed hits
(`WINDOWS_GUARD_ALLOWED`): Helium's sync backends take an `os_crypt_async::Encryptor` (no key change), the event-log
patch edits the elevation service's build, and the installer bundles the elevation service. Tonight: 16 skips guarded,
356 applied patches checked, 11 allowlisted hits.

Resources: Helium's (its icons made with `sips`), then `ardia_resources.txt` as on the Mac, then
`ardia_resources_win.txt`: the app's `Ardia.ico` as `chrome/app/theme/chromium/win/chromium.ico`. helium-windows'
generated `.ico` files aren't made; ours replaces the app icon and Chromium's document icons stay.

On the Windows tree (2026-11-10): `pins` and `guard` pass, 356 patches applied with no fuzz, 16 skipped; the uBlock patches go in without the omitted downloads' files, as on the Mac; `namesub` changed 2168 files; 56 Helium resources, 34 Ardia ones and the Windows icon. 2 min 51 s in all.

## Our series on Windows

`04-series.sh` applies every `chromium` line of `engine/patches/series`, minus the `skip` lines of
`scripts/windows/engine/series-win`, then that file's own `chromium` lines (patches in `scripts/windows/engine/patches/`),
strictly with `git apply` and else with `patch`'s fuzz. It records a failure and goes on, and writes
`~/chromium-build-win/logs/series-win.tsv`. `series-win` today: one skip and twelve Windows-only patches (the table).
A shared `chromium` line may end in a platform tag since the Linux port: untagged lines are for every platform, and
Windows takes those and the `mac` ones (the set it started from), never `linux`.
The layers:

- `engine/chromium/apply.sh` runs as is. Its `chrome/browser/ardia` (the `ac_*` C API) then builds on Windows from a
  copy `series_win.py layer` makes: the Mac sources with `ardia-layer-win.patch` (UTF-8 paths, and Windows absolute
  paths accepted where the Mac checks for a leading `/`), Windows stand-ins for the two
  POSIX-only files, and a build file generated from the shared one: its shared sources less `.mm` and `pip/`, and from
  its Mac block the portable files in `WINDOWS_FROM_MAC_BLOCK` (`ac_reauth.cc`). The Ardia logos it replaces are
  OS-neutral and give the Windows build its branding.
- `series_win.py layer` also copies `//ardia/win` into the tree, with `EngineApi.h` from the app and a generated table
  of the `ac_*` exports, made only from the sources Windows compiles.
- `check_inputs.py` runs those same steps without a Chromium tree, on every pull request (the "Windows engine inputs"
  workflow), and fails, naming the file and line, when the shared inputs change in a way the Windows build can't take:
  a series line it can't read or a patch that isn't there, a `series-win` skip that names nothing, `ardia-layer-win.patch`
  not applying without fuzz, a BUILD.gn it can't turn into the Windows one, a source or engine call Windows would build
  that isn't there. The patches Windows applies and the layer sources it compiles are recorded in
  `accepted-patches.txt` and `accepted-layer-sources.txt`; a change to either is taken on purpose with
  `check_inputs.py --accept`. `chrome.dll` depends on it; `//ardia/win:probe` builds `ArdiaProbe.dll`, a stand-in for the app.
- `engine/ardiacore/apply.sh` doesn't run: it is Mac code. Only `ardia/core/ac_hooks.h` and `ac_content_hooks.h` are
  copied, because the hook patches include them (`// nogncheck`) and they are OS-neutral. With nothing setting the
  hooks, Chrome behaves as stock.

"Touches" is from the patch's files (Mac only: `.mm`, `mac/`, `cocoa`, keychain, Apple-only); "Windows" says what
a Windows build needs.

| Patch | On the Windows tree | Touches | Windows |
|---|---|---|---|
| `chromium-helium-branding.patch` | applies | Mac and shared | The shared hunks hold on Windows (Helium's services off, its URLs emptied); check the literals helium-windows' `change-branding.patch` adds |
| `chromium-cef-carryover.patch` | applies | Mac and shared | Its `remote_cocoa` hunks are Mac only. It gives `LoadLocalState` a ResourceBundle delegate whose Mac caller is `engine/ardiacore/apply.sh` (H5); `chromium-win-load-local-state-delegate.patch` passes none on Windows |
| `chromium-autofill-address-bubble-window.patch` | applies | OS-neutral | Shared; for ArdiaCore's windows and hooks, inert until a Windows ArdiaCore uses them |
| `chromium-device-chooser-hook.patch` | applies | OS-neutral | Shared; for ArdiaCore's windows and hooks, inert until a Windows ArdiaCore uses them |
| `chromium-media-access-hook.patch` | applies | OS-neutral | Shared; for ArdiaCore's windows and hooks, inert until a Windows ArdiaCore uses them |
| `chromium-cast-dialog-hook.patch` | applies | OS-neutral | Shared; for ArdiaCore's windows and hooks, inert until a Windows ArdiaCore uses them |
| `chromium-side-panel-hook.patch` | applies | OS-neutral | Shared; for ArdiaCore's windows and hooks, inert until a Windows ArdiaCore uses them |
| `chromium-ntp-promo-without-side-panel.patch` | applies | OS-neutral | Shared; for ArdiaCore's windows and hooks, inert until a Windows ArdiaCore uses them |
| `chromium-storage-pressure-bubble-without-browser-view.patch` | applies | OS-neutral | Shared; for ArdiaCore's windows and hooks, inert until a Windows ArdiaCore uses them |
| `chromium-remoting-dialog-without-browser-view.patch` | applies | OS-neutral | Shared; for ArdiaCore's windows and hooks, inert until a Windows ArdiaCore uses them |
| `chromium-action-open-popup-without-active-tab.patch` | applies | OS-neutral | Shared; for ArdiaCore's windows and hooks, inert until a Windows ArdiaCore uses them |
| `chromium-initial-document-access.patch` | applies | OS-neutral | Shared; nothing more |
| `chromium-hidden-window-current-window.patch` | applies | OS-neutral | Shared; for ArdiaCore's windows and hooks, inert until a Windows ArdiaCore uses them |
| `chromium-devtools-redock-display.patch` | applies | Mac only | Counterpart when a Windows ArdiaCore docks DevTools in its own windows |
| `chromium-devtools-window-title.patch` | applies | OS-neutral | Shared; nothing more |
| `chromium-global-trace-id-64bit.patch` | applies | OS-neutral | Shared; nothing more |
| `chromium-drag-start-event-id.patch` | applies | OS-neutral | Shared; nothing more |
| `chromium-devtools-control-token.patch` | applies | OS-neutral | Shared; nothing more |
| `chromium-capture-wake-lock-awake-only.patch` | applies | OS-neutral | Shared; nothing more |
| `chromium-devtools-find-detach-keeps-selection.patch` | applies | OS-neutral | Shared; nothing more |
| `chromium-extension-install-prompt-hook.patch` | applies | OS-neutral | Shared; for ArdiaCore's windows and hooks, inert until a Windows ArdiaCore uses them |
| `chromium-webstore-direct.patch` | applies | OS-neutral | Shared; nothing more |
| `chromium-extension-updates.patch` | applies | OS-neutral | Shared; nothing more |
| `chromium-component-updater-security-only.patch` | applies | OS-neutral | Shared; nothing more |
| `chromium-extension-omaha-attributes.patch` | applies | OS-neutral | Shared; nothing more |
| `chromium-extension-management-policy-hook.patch` | applies | OS-neutral | Calls `ardia::RegisterManagementPolicyProviders`, defined in the Mac-only `chrome/browser/ardia`: `chromium-win-ardia-layer-calls-mac-only.patch` leaves the call out on Windows until that layer builds there |
| `chromium-extension-sync-installer-hook.patch` | applies | OS-neutral | Shared; for ArdiaCore's windows and hooks, inert until a Windows ArdiaCore uses them |
| `chromium-unpacked-load-path-hook.patch` | applies | OS-neutral | Shared; for ArdiaCore's windows and hooks, inert until a Windows ArdiaCore uses them |
| `chromium-extension-window-hidden.patch` | applies | OS-neutral | Shared; for ArdiaCore's windows and hooks, inert until a Windows ArdiaCore uses them |
| `chromium-active-web-contents-without-active-tab.patch` | applies | OS-neutral | Shared; for ArdiaCore's windows and hooks, inert until a Windows ArdiaCore uses them |
| `chromium-tpm-metrics-off.patch` | applies | OS-neutral | Shared; nothing more |
| `chromium-component-extension-restricted-urls.patch` | applies | OS-neutral | Shared; nothing more |
| `chromium-component-extension-disk-messages.patch` | applies | OS-neutral | Shared; nothing more |
| `chromium-helium-ublock-off.patch` | applies | OS-neutral | Shared; nothing more |
| `chromium-helium-onboarding-off.patch` | applies | OS-neutral | Shared; nothing more |
| `chromium-helium-services-page-off.patch` | applies | OS-neutral | Shared; nothing more |
| `chromium-helium-search-assets-off.patch` | applies | OS-neutral | Shared; nothing more |
| `chromium-helium-bangs-off.patch` | applies | OS-neutral | Shared; nothing more |
| `chromium-helium-rlz-for-cdm-storage-id.patch` | applies | OS-neutral | Shared; nothing more |
| `chromium-helium-ntp-third-party.patch` | applies | OS-neutral | Shared; nothing more |
| `chromium-helium-context-menu-cast.patch` | applies | OS-neutral | Shared; nothing more |
| `chromium-helium-devtools-inspect-shortcut.patch` | applies | OS-neutral | Shared; nothing more |
| `chromium-helium-noise-common-hardware.patch` | not yet built | OS-neutral | Shared: the core count; the GPU name only changes on an Apple GPU. Neither helium-windows nor a Windows patch touches its files |
| `chromium-device-memory-cap.patch` | not yet built | OS-neutral | Shared; nothing more |
| `chromium-neterror-game.patch` | applies | OS-neutral | Shared; nothing more |
| `chromium-branding.patch` | applies | OS-neutral | The `BRANDING` file; its bundle and team ids are Mac's. Windows install names come from the same file and Helium's Windows branding |
| `chromium-safe-storage-name.patch` | applies | Mac only | None: Windows keeps the cookie and password key in `Local State`, encrypted with DPAPI, with no item name |
| `chromium-safe-storage-no-silent-reset.patch` | **skipped** (`series-win`) | Mac only | Its context is helium-macos' `prevent-reset-on-keychain-unavailability`, which a Windows tree doesn't have. Counterpart needed: a DPAPI decrypt failure must not silently replace the key (`dpapi_key_provider.cc`, `os_crypt_win.cc`) |
| `chromium-password-bubble-hook.patch` | applies | OS-neutral | Shared; for ArdiaCore's windows and hooks, inert until a Windows ArdiaCore uses them |
| `chromium-password-generation-local.patch` | applies | OS-neutral | Shared; nothing more |
| `chromium-password-string-erase.patch` | applies | OS-neutral | Shared; nothing more |
| `chromium-os-crypt-decrypt-erase.patch` | applies | OS-neutral | Shared; nothing more |
| `chromium-window-docked-devtools.patch` | applies | OS-neutral | Shared; for ArdiaCore's windows and hooks, inert until a Windows ArdiaCore uses them |
| `chromium-window-hosted.patch` | applies | Mac and shared | Its `bridged_content_view` hunks are Mac only; counterpart in the Windows host window |
| `chromium-extension-installed-bubble.patch` | applies | OS-neutral | Shared; for ArdiaCore's windows and hooks, inert until a Windows ArdiaCore uses them |
| `chromium-pip-overlay-window.patch` | applies | OS-neutral | Calls `NewArdiaVideoOverlayWindow` (Dia's PiP window, in the Mac-only `chrome/browser/ardia`): on Windows `chromium-win-ardia-layer-calls-mac-only.patch` makes Chrome's own window instead |
| `chromium-tab-sharing-capturer.patch` | applies | OS-neutral | Shared; for ArdiaCore's windows and hooks, inert until a Windows ArdiaCore uses them |
| `chromium-desktop-capture-window-audio.patch` | applies | OS-neutral | Shared; nothing more |
| `chromium-video-super-resolution.patch` | applies | Mac and shared | Its compositor hunks are Mac only; a Windows version would sit in viz's Windows output surface |
| `chromium-keep-old-frame-on-swap.patch` | applies | Mac only | Counterpart if the Windows host shows the same blank frame on a tab swap |
| `chromium-freeze-spares-live-connections.patch` | applies | OS-neutral | Shared; nothing more |
| `chromium-temporary-tab-restore-hook.patch` | applies | OS-neutral | Shared; for ArdiaCore's windows and hooks, inert until a Windows ArdiaCore uses them |
| `chromium-hosted-browsers-no-session-service.patch` | applies | OS-neutral | Shared; for ArdiaCore's windows and hooks, inert until a Windows ArdiaCore uses them |
| `chromium-auto-pip-global-switch.patch` | applies | OS-neutral | Shared; nothing more |
| `chromium-media-session-main-frame-handler.patch` | applies | OS-neutral | Shared; nothing more |
| `chromium-pip-user-agent-ignores-page-opt-out.patch` | applies | OS-neutral | Shared; nothing more |
| `chromium-widevine-without-cdm.patch` | applies | OS-neutral | Shared; nothing more |
| `chromium-angle-metal-shader-cache.patch` | applies | OS-neutral | None: it is in the Mac framework's bundle data |
| `chromium-ungoogled-disable-default-extensions.patch` | applies | OS-neutral | Shared; nothing more |
| `chromium-ungoogled-disable-missing-key-warning.patch` | applies | OS-neutral | Shared; nothing more |
| `chromium-ungoogled-mime-util-ymp.patch` | applies | OS-neutral | Shared; nothing more |
| `chromium-background-instance-no-default-handlers.patch` | applies | Mac only | Counterpart in `shell_integration_win.cc`: a background instance registers no protocol handlers |
| `chromium-apple-passwords-host-skipped.patch` | applies | OS-neutral | None: `launch_context_posix.cc` isn't built on Windows |
| `chromium-extension-tab-move-closing-window.patch` | applies | OS-neutral | Shared; nothing more |
| `chromium-enterprise-context-info.patch` | applies | OS-neutral | Shared; `getContextInfo` answers with the device's context in a build without cloud content analysis, which Windows is too (`enterprise_cloud_content_analysis` defaults to false in its tree), so Endpoint Verification gets an answer there as well. Applies strictly to the Windows tree's copy of the file (checked 2026-11-16) |
| `chromium-ardia-layer.patch` | applies | OS-neutral | It links `chrome/browser/ardia` into the Mac framework only; Windows needs the same link once the `ac_*` layer builds there |
| `chromium-win-rtl-unittest-domsub.patch` | applies (Windows only, `series-win`) | OS-neutral | Puts back the `base_unittests` literals Helium's domain substitution breaks |
| `chromium-win-load-local-state-delegate.patch` | applies (Windows only, `series-win`) | OS-neutral | `chrome_main_delegate.cc` calls `LoadLocalState` with no delegate, as stock Chrome |
| `chromium-win-ardia-layer-calls-mac-only.patch` | applies (Windows only, `series-win`) | OS-neutral | The two calls into `chrome/browser/ardia` become Mac only |
| `chromium-win-mac-host-sdk-any-toolchain.patch` | applies (Windows only, `series-win`) | Mac only | `mac_sdk.gni` may be read from any toolchain when a Mac host builds for Windows; arm64 needs it ([ARM64](#arm64)) |
| `chromium-win-app-message-pump.patch` | applies (Windows only, `series-win`) | Windows only | The UI message pump offers each message to the app first, so React Native's windows get their keys and accelerators |
| `chromium-win-hosted-browser-windows.patch` | applies (Windows only, `series-win`) | Windows only | The hooks `//ardia/win` sets: every normal browser window is page only with a frameless frame view, and the app's main parts join the browser's |
| `chromium-win-child-window-activation.patch` | applies (Windows only, `series-win`) | Windows only | Lets a browser window that is a child window take activation; unused since hosted windows are top-level, harmless |
| `chromium-win-app-in-browser-process.patch` | applies (Windows only, `series-win`) | Windows only | `chrome.dll` links `//ardia/win` and calls it before Chrome's main and after it: with `ArdiaApp.dll` beside the launcher the browser process runs the app, and ends as soon as Chromium's shutdown returns, without running exit handlers (#1706) |
| `chromium-win-install-names.patch` | applies (Windows only, `series-win`) | Windows only | The install is named Ardia (`%LOCALAPPDATA%\Ardia\User Data`), and `ARDIA_DATA_DIR` moves Chromium's data |
| `chromium-win-hosted-page-fills-window.patch` | applies (Windows only, `series-win`) | Windows only | A hosted window has no rounded page frame or insets: the page fills it |
| `chromium-win-hosted-no-browser-shortcuts.patch` | applies (Windows only, `series-win`) | Windows only | Chrome's own accelerators are off in hosted windows, so Ctrl+L and the rest reach the app |
| `chromium-win-relaunch-to-app.patch` | applies (Windows only, `series-win`) | Windows only | A second launch's command line goes to `//ardia/win` instead of Chrome's startup, which would open nothing under `--no-startup-window` |
| `chromium-win-discard-asks-the-host.patch` | applies (Windows only, `series-win`) | OS-neutral | Every discard but one the user or one of their extensions asks for (`EXTERNAL`: Chrome's Memory Saver timer, its urgent and frozen-with-growing-memory discards and the app's `sleepIfHidden` all do) asks `//ardia/win`'s `g_ardia_keeps_page` before Chromium's own early answers; a page the app keeps is protected (`kExtensionProtected`), which Windows' urgent discards skip |
| `chromium-win-devtools-other-clients.patch` | applies (Windows only, `series-win`) | OS-neutral | `content::ArdiaHasOtherDevToolsClient`: whether a DevTools client other than the engine's own is attached to a page, so the engine's always-attached Peek client doesn't count as DevTools open |

Every patch that applies does so strictly (`git apply`, no fuzz). 72 of the Mac series' 73 apply; the one left out is a
Mac-only keychain patch. Four Windows-only patches follow them (`series-win`). The file classes above come from paths, so a
shared file can still call into Mac-only code: two did (`chrome.dll` failed to link without the guard patch).

## GN args

`gn_defines.sh` takes the Mac list (`gn_defines.sh`) and changes it, so the two can't drift apart unnoticed:

The resulting `out/Release_GN_win_x64/args.gn`:

```
alternate_cdm_storage_id_key="968b476909da4373b08903c28e859454"
blink_symbol_level=0
branding_file_path="//chrome/app/theme/ardia/BRANDING"
chrome_pgo_phase=0
clang_use_chrome_plugins=false
dcheck_always_on=false
disable_fieldtrial_testing_config=true
enable_background_mode=false
enable_cdm_storage_id=true
enable_downgrade_processing=false
enable_hangout_services_extension=false
enable_iterator_debugging=false
enable_mse_mpeg2ts_stream_parser=true
enable_precompiled_headers=false
enable_remoting=false
enable_reporting=false
enable_resource_allowlist_generation=false
enable_rlz=true
enable_swiftshader=false
enable_updater=false
enable_widevine=true
exclude_unwind_tables=true
fatal_linker_warnings=false
ffmpeg_branding="Chrome"
forbid_non_component_debug_builds=false
google_api_key=""
google_default_client_id=""
google_default_client_secret=""
is_component_build=false
is_debug=false
is_official_build=false
optimize_webui=true
proprietary_codecs=true
safe_browsing_mode=0
symbol_level=0
target_cpu="x64"
target_os="win"
treat_warnings_as_errors=false
use_official_google_api_keys=false
use_thin_lto=false
use_unofficial_version_number=false
v8_drumbrake_bounds_checks=true
v8_symbol_level=0
```

| Dropped or changed | Why | For the official configuration |
|---|---|---|
| `is_official_build=true` → `false` | the first build proves the tree, not the shipping configuration | back to `true` |
| `chrome_pgo_phase=2` → `0` | PGO comes with the official build | `2`, with `chrome/build/win64.pgo.txt` (`checkout_pgo_profiles` is already on) |
| ThinLTO (`use_thin_lto=false`) | official builds turn it on; it multiplies link memory | on, with the official build |
| `target_cpu="arm64"` → `"x64"`, `target_os="win"` | the target | arm64 Windows later, as its own out dir |
| `enable_cdm_host_verification=true` | on Windows it signs `chrome.exe` and `chrome.dll` for Widevine at build time (`widevine_sign_file`, `signature_generator.py`); not needed to prove the tree | back on, with Widevine's VMP signing |
| `enable_swiftshader=false` (added) | Helium's Windows flags; `honor-swiftshader-buildflag.patch` makes it hold | keep |

`exclude_unwind_tables=true` stays: it only changes POSIX targets' flags, so it does nothing on Windows.

Kept: proprietary codecs (`ffmpeg_branding="Chrome"`), Widevine, the CDM storage id and its
`alternate_cdm_storage_id_key` (never changes), RLZ for it, no Google API keys, Safe Browsing mode 0, no reporting,
no field-trial config, no updater, no background mode, `symbol_level=0`, not a component build, and
`branding_file_path` (`//chrome/app/theme/ardia/BRANDING`).

## Packaging

`06-package.sh` packs an out dir the way Chromium's CI packs its Windows snapshots, rather than from a file list of
ours: `chrome/tools/build/make_zip.py` with the `chrome-win.zip` archive of `infra/archive_config/win-archive-rel.json`
(`win-arm64-archive-rel.json` for arm64). The CI archive builders upload that zip as the runnable Chromium for
Windows. `chrome/tools/build/win/FILES.cfg` says it is obsolete for archiving and points at those configs.
`//chrome:mini_installer` would need `setup.exe` and the installer's archive, which this build doesn't make, and a
package that installs and registers itself is more than a throwaway test needs.

The configs' paths are written for a Windows host (`locales\*.pak`, `IwaKeyDistribution\manifest.json`) and
`make_zip.py` hands them to `glob` as they are, so on a Mac they match nothing. `06-package.sh` gives it a copy with
forward slashes. Then `package_win.py` compares the zip with `gn desc out/Release_GN_win_<cpu> //chrome:chrome
runtime_deps` (case-insensitively, as Windows does: the config says `D3DCompiler_47.dll`, the build writes
`d3dcompiler_47.dll`), writes what differs to `~/chromium-build-win/package/<cpu>/missing-runtime-deps.txt`, and adds
`chrome-win/RUN.txt`: how to unblock, unzip and start it with a throwaway profile, and that nothing in it is signed.

x64 on 2026-11-11: `ardia-chromium-win-x64.zip`, 195 MB, 252 files (464 MB unpacked), SHA-256
`8c74a1aafb818c0a4e11d424e59a9a43b82b5c7810a4e3fdfa3c6290bbb60908`. What `runtime_deps` lists and the zip leaves out,
none of it needed to start the browser:

| Left out | Files | Why |
|---|---|---|
| `gen/third_party/devtools-frontend/src/…` | 8,475 | DevTools' unbundled front end, for DevTools' own tests; the browser uses the copy in `resources.pak` |
| `pyproto/google/…` | 37 | Python protobuf modules for test tooling |
| `VkICD_mock_icd.dll`, `VkLayer_khronos_validation.dll`, `angledata/*.json` | 6 | Vulkan's mock driver and validation layer, for ANGLE's tests |
| `dbghelp.dll`, `msdia140.dll` (and `dbgcore.dll`, not built) | 3 | Symbolizing crash stacks in-process; Windows has its own `dbghelp.dll` |
| `resources/accessibility/reading_mode_gdocs_helper_manifest.json` | 1 | The Reading mode Google Docs helper's manifest; the CI archive leaves it out too |

And what the CI archive lists that this build doesn't make: `chrome_renderer.dll` (a glob for a split-renderer
configuration), `eventlog_provider.dll` (helium-windows' `windows-disable-event-log`), `MEIPreload/*` (the Media
Engagement preload component, which this build doesn't download), `interactive_ui_tests.exe` and `setup.exe` (not
built), `vk_swiftshader.dll` and its `.json` (`enable_swiftshader=false`). `snapshot_blob.bin` stands in for
`v8_context_snapshot.bin`, as `make_zip.py` allows.

Not checked: that it starts. Nobody had a Windows machine; `RUN.txt` has the command.

## ARM64

The toolchain has everything an arm64 target needs: MSVC's `lib/arm64`, the SDK's `um`/`ucrt` arm64 libraries, the
`sysarm64` runtimes, and Chromium's clang has `clang_rt.*-aarch64.lib`. Chromium builds Rust's standard library from
source, so no prebuilt arm64 Rust is needed. `WIN_CPU=arm64` selects `target_cpu = "arm64"` and
`out/Release_GN_win_arm64`; everything else in the args is the same.

Two things stopped `gn gen`:

1. **`dbghelp.dll` for arm64** (`Debuggers/arm64`): see [Debuggers](#the-toolchain). Fixed by `debuggers.sh`.
2. **`mac_sdk.gni`'s assertion.** An arm64 Windows build also has an x64 toolchain, and on a Mac host Blink's
   `scripts.gni` imports `mac_sdk.gni` in every toolchain (`gperf` comes from Xcode). `mac_sdk.gni` asserts it is only
   read for macOS, the default toolchain or Android. `chromium-win-mac-host-sdk-any-toolchain.patch` (`series-win`)
   lets a Mac host building for Windows read it from any toolchain. x64 builds never hit it: their only Windows
   toolchain is the default.

While adding that patch, `04-series.sh` applied `chromium-extension-management-policy-hook.patch` a second time: once
`chromium-win-ardia-layer-calls-mac-only.patch` had edited the same lines, the reverse check that tells an applied
patch no longer recognised it. `chrome_extension_system.cc` was restored from the series base with its three patches
replayed, and `series_win.py` now records every patch it applies in `.series-win-applied` beside the tree and never
applies a recorded one again. The x64 build was linked before this and isn't affected.

## What failed and how it was fixed

In the order they happened on 2026-11-10:

1. **The network.** The MacBook was on a mobile link that swung between 60 KB/s and 15 MB/s. The first `gclient sync`
   fetched Chromium's tag and the git deps, then sat for an hour in `cipd ensure`, which downloads over one
   connection: a Windows checkout from a Mac host asks for ~95 CIPD packages, most of them test data, other platforms'
   tools and the updater's and enterprise companion's prebuilt binaries. Fixed: `target_os_only = True` (gclient
   otherwise adds the host, `mac`, to `target_os`: 43 packages left), and `gclient sync --ignore-dep-type=cipd`
   followed by `cipd ensure` on `cipd.ensure`'s 11.
2. **A prompt with no answer.** A detached `gclient sync` that inherited the launching script as stdin blocked
   reading it. Every step now runs with stdin from `/dev/null`.
3. **The toolchain's debuggers.** Visual Studio's SDK package has no Debuggers; `vs_toolchain.py` needs
   `Debuggers/x64/dbghelp.dll`. The SDK's own x64 `DbgHelp.dll` stands in (above).
4. **`gn` without a bootstrapped depot_tools** (`python3_bin_reldir.txt not found`): a fresh clone with
   `DEPOT_TOOLS_UPDATE=0` never bootstraps. `01-sync.sh` runs `ensure_bootstrap` once.
5. **`chromium-safe-storage-no-silent-reset.patch` doesn't apply**: its context is a helium-macos patch. It is Mac
   only, so `series-win` skips it; the Windows counterpart is still to write (the patch table).
6. **`base_unittests`: "hex escape sequence out of range"** in `base/i18n/rtl_unittest.cc`: Helium's domain
   substitution turned `L"\x202egoogle.com"` into `L"\x202e9oo91e.qjz9zk"`, and the escape took the `9`. Only a test;
   the Mac build never compiles it. `chromium-win-rtl-unittest-domsub.patch` (`series-win`) puts the literals back.
   With it, `base_unittests.exe` links: PE32+ x86-64, 41.6 MB.
7. **`chrome`: Dawn's Tint source generator runs Go** (`third_party/dawn/tools/golang/mac-arm64/bin/go`), which the
   first trimmed CIPD list left out. Added to `cipd.ensure`.
8. **Swap.** At siso's default parallelism (local jobs from the CPU count) on 24 GB, nine of Blink's
   `generate_bindings.py` ran at once, each with a worker per core loading the IDL database: 171 Python processes,
   13 GB of swap, load 127, and SSH stopped answering. `05-build.sh` now defaults to 8 local jobs. siso has no
   separate link pool (`SISO_LIMITS=link=…` is "unknown limits name"), so the job count bounds links too.
9. **`chrome`: `chrome_main_delegate.cc` calls `LoadLocalState` with two arguments**: `chromium-cef-carryover.patch`
   added a third, and on the Mac `engine/ardiacore/apply.sh` updates this call. Fixed by
   `chromium-win-load-local-state-delegate.patch`.
10. **`chrome.dll` doesn't link: two undefined symbols** from `chrome/browser/ardia`, which only the Mac builds:
    `ardia::RegisterManagementPolicyProviders` and `NewArdiaVideoOverlayWindow`. Fixed by
    `chromium-win-ardia-layer-calls-mac-only.patch`. With it, `chrome` builds.

## Moving to Chromium 158 (2026-11-18)

From 157.0.8103.38 with Helium 0.21.1 straight to 158.0.8127.36 with Helium 0.22.1, on a fresh xlarge Boat VM: sync and
toolchain 11 min (Visual Studio's channel now gives MSVC 14.52.37029, the hash stays `44da279f35`), step 3 2 min (372
patches, 16 skips, guard clean), and the x64 `chrome` build about 1 h 35 min at `JOBS=18` with no compile error.
Three Windows patches needed rebasing: `chromium-win-hosted-no-browser-shortcuts.patch` (`LoadAccelerators` now
`CHECK`s its focus manager; fuzz would have put the hook in another function), `chromium-win-reauth-app-window.patch`
(include context) and `chromium-win-autoplay-policy.patch` (158 added `can_use_device_bound_session_js_api` as the last
`CommitNavigationParams` field; `ardia_autoplay_blocked` follows it). In `//ardia/win`, `WindowOpenDisposition` values
are kCamelCase, and `TabEvents` asks for the live `PopupBlockerTabHelper` before each use: Chromium 158 made it a tab
feature that is freed before `WebContentsDestroyed`, as the Mac's TabBridge found.

## Resuming

Everything stays on the build machine: the checkout, `win-toolchain/` (the unpacked download, the zip, `env.sh`), the
Helium checkouts and `out/Release_GN_win_x64`. With the scripts in a clone of this repo and a lock root
(`export AC_LOCK_ROOT=<dir>`; the Windows tree is not the protected `~/chromium-build`, so any lock root works):

```
lock() { lockf -k "$AC_LOCK_ROOT/ac-chromium.lockf" "$@" < /dev/null; }
TARGETS=chrome lock scripts/windows/engine/05-build.sh --apply
WIN_CPU=x64 lock scripts/windows/engine/06-package.sh --apply
WIN_CPU=arm64 TARGETS=chrome JOBS=16 lock scripts/windows/engine/05-build.sh --apply
WIN_CPU=arm64 lock scripts/windows/engine/06-package.sh --apply
```

16 jobs held on this 24 GB machine once Blink's bindings generators were done (`05-build.sh` runs those first, at 3).

The build is incremental: a rerun compiles only what is left. Steps 1 to 4 never need to run again on this tree; step 3
refuses a second run (`.helium-stages-src`), and step 4 skips what is applied. To start over on a new Chromium version,
follow the Mac's "Moving to a new Chromium version" (`docs/engine-build.md`) with `~/chromium-build-win`, the pins in
`helium-pins.ini` here, a new `cipd.ensure` and, when `vs_toolchain.py` names a new SDK, `toolchain.sh` again.
