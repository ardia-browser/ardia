# Building the engine for Linux

The Linux engine is the same tree as the Mac's (`docs/engine-build.md`): **Chromium 157.0.8103.50**, **Helium** 0.21.2
(helium-chromium) with **helium-linux** 0.21.2.1 in place of helium-macos, then our patch series. It is built natively
on Linux x64 against Chromium's own Debian sysroot, so the build needs no system development packages and no root.
What runs on it is in `docs/linux-engine.md` (the app in the browser process, `//ardia/linux`).

The scripts are in `scripts/linux/engine/`, not next to the Mac ones, for the reason `docs/engine-build-windows.md`
gives: `engine/engine-key.sh` hashes the whole `engine/` tree into the Mac's prebuilt-engine key, so nothing for Linux
may live there. They mirror `scripts/windows/engine/`: their own `env.sh` (which sources the Mac's
`engine/patches/build/env.sh`), `helium-pins.ini`, `series-linux` and `series_linux.py`, a `03-helium.py` that imports
the Mac's, and Linux-only patches in `scripts/linux/engine/patches/`. Everything lives in `~/chromium-build-linux`
(`AC_CHROMIUM_BUILD`, which every Linux script defaults to); the Mac's `~/chromium-build` is never touched.

**State on 2026-11-15 (Ubuntu 24.04 x86_64, 16 cores, 62 GB, no root).** Proven: the tree syncs with no system
packages, Helium and our series apply (343 Helium patches with no fuzz, 72 of the Mac series' 73 patches strictly), `gn
gen` passes and `chrome` links: an ELF x86-64 PIE, 1.74 GB with its debug info, in
`~/chromium-build-linux/chromium_git/chromium/src/out/Release_GN_linux_x64`. It runs on a private Xvfb:
`chrome://version` says **Ardia 157.0.8103.50 (Developer Build) (x86_64)** over Chromium 157.0.8103.50, with Ardia's
mark, a page loads, and `helium-check-build.py` passes on the Linux output ([Running it](#running-it)). Then the layer:
`chrome/browser/ardia` built for Linux, `//ardia/core`'s portable files, `//ardia/win`'s shared files, the hooks and the
app patches are applied to the tree and `gn gen` passes with them (36,567 targets); the app layer itself
(`//ardia/linux`) is the engine host's work (`docs/linux-engine.md`). Not built yet: the official configuration
(below).

## Steps

Run them in the order 1, 3, 4, 2, 5, 6. Each needs `--apply` and takes the Linux tree's lock itself:
`/tmp/ac-chromium-linux.lockf` (`$AC_LINUX_LOCK` in `env.sh`, under `AC_LOCK_ROOT`, default `/tmp`), a `flock` lock
that dies with its holder. A step that finds the lock held waits up to `AC_LOCK_WAIT` seconds (default 500), then exits
75. Anything else that writes to the tree or builds in it takes the same lock: `flock -w 500 /tmp/ac-chromium-linux.lockf
<command>`. A step run under a holder (`AC_LINUX_LOCK_HELD` names the lock and the lock is held) runs straight through.
Each step appends its start and its duration to `~/chromium-build-linux/logs/step-times.log`.

| Step | Script | What it does | Time (16 cores, 62 GB, 2026-11-15) |
|---|---|---|---|
| 1 | `01-sync.sh` | Clones depot_tools if missing and bootstraps it; clones helium-chromium into `helium/` and helium-linux into `helium-linux/` at the pinned commits (`pins.py`; a checkout elsewhere or with changes is refused); unpacks the host tools (`host-tools.sh`); writes `.gclient` with `target_os = ['linux']` and `target_os_only = True`; fetches Chromium's tag at depth 1; `gclient sync --no-history` (every git, GCS and CIPD dep); then the hooks: clang, Rust, the Debian bullseye sysroot, node, the PGO profiles | 10 min 13 s for the first run (30 GB); 29 s for a rerun on a synced tree |
| 3 | `03-helium.py` | The Mac step 3 with helium-linux ([below](#helium-for-linux)) | 3 min 25 s |
| 4 | `04-series.sh` | The series base, then `series_linux.py apply`: our patches, the layers, the hooks ([below](#our-series-on-linux)); then the offline game | 1 s |
| 2 | `02-gn-args.sh` | `out/Release_GN_linux_x64/args.gn` from `gn_defines.sh`, then `gn gen` | 5 s (36,517 targets) |
| 5 | `05-build.sh` | `autoninja` on `TARGETS` (default `chrome`) with `JOBS` local jobs (default 16); for `chrome`, Blink's bindings generators first at `BINDINGS_JOBS` (default 4). Output is appended to `LOG` (default `logs/05-build.log`) | `chrome` from a fresh out dir: 2 h 46 min, about 6 min of it lost to a restart (one pass at 16 jobs; memory never short: 46 GB or more stayed available, no swap) |
| 6 | `06-package.sh` | `ardia-chromium-linux-x64.tar.xz` and `SHA256SUMS` in `~/ardia-linux/out` ([Packaging](#packaging)) | a few minutes (xz of the stripped files) |

`check-build.sh` runs the Mac's leak check on the output (below). Long steps run detached so a tool's time limit can't
stop them: `setsid nohup scripts/linux/engine/05-build.sh --apply >/dev/null 2>&1 </dev/null &`, then follow
`logs/05-build.log`. Never stop a step with `pkill -f <script name>`: it also matches the shell that started it, which
leaves its children (siso) running without the lock.

Disk: 45 GB in `~/chromium-build-linux`: the checkout 30 GB, its out dir 14 GB after `chrome` (with `symbol_level=1`), depot_tools 1.3 GB, the domain-substitution cache 157 MB, the series base 12 MB, the Helium checkouts 22 MB.

**The host tools.** Chromium's sysroot has every library and header the build links against; what it can't carry is a
host program the build runs. Two are needed and aren't on a stock Ubuntu 24.04: `gperf` (Blink's `scripts.gni` runs
`gperf` from `PATH` on a Linux host; macOS has it from Xcode, Windows from the tree) and `rsync`
(`engine/chromium/apply.sh`). `host-tools.sh` fetches Ubuntu's own packages with `apt-get download` and unpacks them
with `dpkg-deb -x` into `~/chromium-build-linux/host-tools`, and `env.sh` puts its `usr/bin` on `PATH`; their shared
libraries are the system's. No root is needed.

## Helium for Linux

helium-linux 0.21.2.1 (`c594074`) is Helium's Linux packaging for 0.21.2. Its `helium-chromium` submodule is at
`e817502`, the 0.21.2 tag we pin; step 3's `pins` stage checks that, besides the Mac's checks. Over helium-chromium's
series it adds seven patches: ungoogled-chromium's `use-oauth2-client-switches-as-default`, and Helium's Linux branding,
binary rename, default (non-GTK) theme, middle-click paste flag, missing `.desktop` file error and no tab strokes. Its
packaging (AppImage, `.deb`, `.rpm`, the wrapper script, AppArmor profile) is outside the series and isn't used.

`03-helium.py` runs the Mac's `03-helium.py` (imported, so the stages, the guard, the omitted downloads and the
substitutions are the same code) with helium-linux for helium-macos. The Mac's skips of helium-macos patches are left
out; the skips of helium-chromium patches stay, and these are added (`LINUX_SKIP`):

| Patch | Why |
|---|---|
| `helium/linux/change-chromium-branding` | moves the profile to `~/.config/net.imput.helium` (`.dev` for an unofficial build), reads `HELIUM_CONFIG_HOME` and `HELIUM_DESKTOP` and names `helium.desktop`; Ardia's Linux layer names its own data folder and `.desktop` file (the Mac skips `change-product-dir-name` for the same reason) |
| `helium/linux/rename-chrome-binary` | renames the binary to `helium` and the crash handler to `helium_crashpad_handler`; the engine stays `chrome` (the package renames it `ardia.bin`) |
| `helium/linux/add-error-for-missing-desktop-file` | a "cannot be set as default" state whose Settings string names `helium.desktop`: `brand-namesub` refuses a user-visible Helium string, and Ardia's Linux layer owns its `.desktop` file and its default-browser flow |

The guard also watches Linux's key storage (`os_crypt`, libsecret, KWallet, `key_storage`). Its reviewed hits
(`LINUX_GUARD_ALLOWED`) are Windows' four `os_crypt` ones in Helium's sync backends, which take an
`os_crypt_async::Encryptor` and change no key; nothing in Helium's or helium-linux's series touches libsecret or KWallet.
2026-11-15: 9 skips guarded, 343 applied patches checked, 7 allowlisted hits.

Two Mac mechanisms needed a Linux stand-in:

- **Icons.** Helium generates its product icons from one PNG with `sips` (macOS only). Here they are made with Pillow
  (Lanczos), the same sizes and files. Then `ardia_resources.txt` as on the Mac, then `ardia_resources_linux.txt`: Ardia's
  logos (`engine/chromium/src/chrome/app/theme/chromium/product_logo_*.png`) over Helium's Linux product logos
  (`chrome/app/theme/chromium/linux/product_logo_{24,48,64,128,256}.png` and
  `default_100_percent/chromium/linux/product_logo_{16,32}.png`), which the Mac list doesn't reach.
- **The scratch-tree check.** The Mac step refuses a tree with a hard-linked file (a write through one would land in
  another). Chromium's Debian sysroot (`build/linux/debian_*-sysroot`) is unpacked from Debian packages with hard links
  between its own files (Mesa's DRI drivers). The Linux step allows those as long as every link of each file is inside
  that sysroot, which nothing in step 3 writes; any other hard link, and any symlink out of the tree, still fails.

On the Linux tree (2026-11-15): `pins` and `guard` pass, 343 patches applied with no fuzz, 9 skipped; the uBlock patches
go in without the omitted downloads' files, as on the Mac; `namesub` changed 2168 files; 56 Helium resources, 34 Ardia
ones and 7 Linux ones. 3 min 25 s in all.

## Our series on Linux

`04-series.sh` captures the series base (`series.py capture-base`, as on the Mac and Windows) and runs
`series_linux.py apply`, in three parts. It writes `~/chromium-build-linux/logs/series-linux.tsv`, records every patch
that goes in in `.series-linux-applied` beside the tree (never applied twice), and reverse-applies a recorded patch
that has left `series-linux`.

**Patches.** Every `chromium` line of `engine/patches/series`, minus `series-linux`'s `skip` lines, then that file's own
lines, each strictly with `git apply` and else with `patch`'s fuzz. Line kinds:

| Line | Meaning |
|---|---|
| `skip <patch>` | a patch of `engine/patches/series` left out |
| `except <patch> <path>...` | a patch of `engine/patches/series` applied without those files; a later line carries their Linux version |
| `chromium <patch>` | a Linux-only patch in `scripts/linux/engine/patches/` |
| `win <patch>` | a patch of `scripts/windows/engine/patches/` a Linux build needs as it is |
| `win-widened <patch>` | one whose added `BUILDFLAG(IS_WIN)` guards also take `IS_LINUX` (rewritten before `git apply`) |

`series-linux` today:

| Line | Why |
|---|---|
| `skip chromium-safe-storage-no-silent-reset.patch` | Its context is helium-macos' `prevent-reset-on-keychain-unavailability`, which a Linux tree doesn't have. Counterpart to check: whether Chrome 157's Linux key providers (`os_crypt_async`'s freedesktop and portal ones) can make a new key while an old one exists when the keyring is late at login |
| `except chromium-helium-branding.patch chrome/browser/helium_flag_choices.h chrome/browser/helium_flag_entries.h` + `chromium chromium-linux-helium-flags-branding.patch` | helium-linux's middle-click paste flag sits at the end of both files and moves the context the Mac patch is made against; the Linux patch makes the same changes on the Linux context and names the new flag `ardia-middle-click-paste-enabled` |
| `win chromium-win-rtl-unittest-domsub.patch` | Helium's domain substitution breaks `base_unittests`' literals (`\x202e9oo91e`), on every OS |
| `chromium chromium-linux-ardia-layer.patch` | `//chrome:chrome` links `chrome/browser/ardia`, the Linux counterpart of `chromium-ardia-layer.patch` |
| `chromium chromium-linux-app-in-browser-process.patch` | `//chrome:chrome` links `//ardia/linux`; `ChromeMain` calls `ardia_linux::BeforeChromeMain()` right after `CommandLine::Init`, in every process, and its delegate is `ardia_linux::MainDelegate` (a `ChromeMainDelegate`) |
| `win-widened chromium-win-external-protocol-dialog.patch` | the external app prompt goes to the app (the shared `//ardia/win/external_apps.cc` sets `g_ardia_win_external_protocol_dialog`) |
| `win-widened chromium-win-relaunch-to-app.patch` | a second launch's command line goes to the app instead of Chrome's startup |
| `chromium chromium-linux-widevine-component.patch` | "Play DRM-protected content", off by default ([GN args](#gn-args), Widevine) |

Retired: `chromium-win-load-local-state-delegate.patch` (the `chrome_main_delegate.cc` hook below passes ArdiaCore's
ResourceBundle delegate instead, as on the Mac) and `chromium-win-ardia-layer-calls-mac-only.patch` (the layer builds on
Linux, so the Scripts policy providers and Dia's Picture in Picture window are in). Both were applied to the first
Linux tree and reverse-applied by the next run.

On the Linux tree, 72 of the Mac series' 73 patches apply strictly; the one left out is the Mac-only keychain patch.

**Layers** (`series_linux.py layer`).

- `chrome/browser/ardia` (`engine/chromium`, the `ac_*` calls) is built for Linux, the way `series_win.py` builds it
  for Windows (its code is reused): the Mac sources, with `scripts/windows/engine/ardia-layer-win.patch` (paths through
  `FromUTF8Unsafe`/`AsUTF8Unsafe` and `IsAbsolute`, which on Linux mean what the Mac's `value()` and leading `/` mean;
  the reauth prompt's Mac-only string), then `scripts/linux/engine/src/chrome/browser/ardia` over them
  (`pip/ac_pip_linux.cc`: the PiP window's bounds kept for the session, no fade, controls drawn by Views), and a
  `BUILD.gn` made from the Mac one: `assert(is_linux)`, no `.mm` and no external apps (Linux uses `//ardia/win`'s
  `external_apps.cc`), `pip/` kept with `ac_pip_linux.cc`, `launch_switches` from `//ardia/win` (as Windows builds it),
  no frameworks and no exported-symbols list. The POSIX files Windows swaps out (`ac_cli_control.cc`,
  `ac_scripts_policy.cc`) build as they are. The replaced logos are copied as on Windows.
- The tree's `ardia/` is made exactly (only changed files written; files nothing names removed):
  - `ardia/core`: the portable files of `engine/ardiacore/src/ardia/core`: the hook headers, `ac_launch_switches`
    (through `series_win.launch_switches_source()`: no keychain, the test-instance switch in place of the Mac's
    signature check, its refusal naming `ardia/linux/test_gate.cc`), `ac_page_limits.h`, `ac_page_script`, the
    renderer client `renderer/ac_content_renderer_client`, and `mojom/`. Its `BUILD.gn` is Linux's own
    (`scripts/linux/engine/src/ardia/core/BUILD.gn`): `hooks`, `page_script` and `renderer`.
  - `ardia/win`: `//ardia/win`'s platform-neutral files, verbatim but for `ardia-win-on-linux.patch` (three
    `FilePath` conversions through `WideToUTF8` that only compile where paths are wide), `public/EngineApi.h` from the
    app, and `ac_calls.cc`, the table of the layer's `ac_*` calls `series_win.engine_calls_source()` generates.
  - Then everything under `scripts/linux/engine/src/ardia` over them: `//ardia/linux` and the Linux overlays of
    `ardia/win/{host.h,hooks.h,BUILD.gn}`.

**Hooks** (`series_linux.py hooks`, `--check` to only check). The hook blocks of `engine/ardiacore/apply.sh` for the
files `linux-hooks` names, one path per line, run through `apply.sh`'s own Python helper, read from `apply.sh` at run
time (so its markers, its `--check` and the include line behave as on the Mac). `apply.sh` itself doesn't run, and
nothing under `engine/` changes. 37 of its 46 blocks are taken; with nothing setting them, Chrome behaves as stock.
Left out:

| File | Why |
|---|---|
| `chrome/BUILD.gn` (`//chrome:chrome_dll`) | links `//ardia/core` into the Mac framework; `chromium-linux-app-in-browser-process.patch` links `//ardia/linux` |
| `chrome/app/chrome_main.cc` | the Mac's `ACMainDelegate`; Linux's delegate comes from `chromium-linux-app-in-browser-process.patch` |
| `chrome/browser/chrome_browser_main_mac.mm`, `components/memory_pressure/system_memory_pressure_evaluator_mac.cc`, the four Bluetooth `_mac`/`_apple` files | Mac only |
| `chrome/browser/external_protocol/external_protocol_handler.cc` | the Mac's `g_ardia_external_protocol_dialog` is set only by `ac_external_apps.mm`; on Linux the widened Windows patch's hook is the one the shared `external_apps.cc` sets, and the two edit the same call |

## GN args

`gn_defines.sh` takes the Mac list and changes it, so the two can't drift apart unnoticed. The resulting
`out/Release_GN_linux_x64/args.gn`:

```
blink_enable_generated_code_formatting=false
blink_symbol_level=0
branding_file_path="//chrome/app/theme/ardia/BRANDING"
chrome_pgo_phase=0
clang_use_chrome_plugins=false
dcheck_always_on=false
disable_fieldtrial_testing_config=true
enable_background_mode=false
enable_downgrade_processing=false
enable_hangout_services_extension=false
enable_iterator_debugging=false
enable_mse_mpeg2ts_stream_parser=true
enable_precompiled_headers=false
enable_remoting=false
enable_reporting=false
enable_resource_allowlist_generation=false
enable_updater=false
enable_widevine=true
exclude_unwind_tables=true
fatal_linker_warnings=false
ffmpeg_branding="Chrome"
forbid_non_component_debug_builds=false
google_api_key=""
google_default_client_id=""
google_default_client_secret=""
is_clang=true
is_component_build=false
is_debug=false
is_official_build=false
optimize_webui=true
proprietary_codecs=true
rtc_use_pipewire=true
safe_browsing_mode=0
symbol_level=1
target_cpu="x64"
target_os="linux"
treat_warnings_as_errors=false
use_kerberos=false
use_official_google_api_keys=false
use_sysroot=true
use_system_libffi=false
use_thin_lto=false
use_unofficial_version_number=false
use_vaapi=true
v8_drumbrake_bounds_checks=true
v8_symbol_level=0
```

| Dropped or changed | Why | For the official configuration |
|---|---|---|
| `is_official_build=true` → `false` | the first build proves the tree, not the shipping configuration | back to `true` |
| `chrome_pgo_phase=2` → `0` | PGO comes with the official build | `2`, with `chrome/build/linux.pgo.txt` (`checkout_pgo_profiles` is on; step 1 fetched it) |
| ThinLTO (`use_thin_lto=false`) | official builds turn it on; it multiplies link memory | on, with the official build |
| `symbol_level=0` → `1` | function names in stacks while the Linux layer is new (helium-linux's release flags use 1) | `0` once the layer has settled |
| `target_cpu="arm64"` → `"x64"`, `target_os="linux"` | the target | arm64 Linux later, as its own out dir |
| `enable_cdm_host_verification` dropped | Windows and Mac only (`media_options.gni` asserts so) | — |
| `enable_rlz` dropped | RLZ is Windows, Apple and ChromeOS only (`rlz/buildflags/buildflags.gni` asserts so) | — |
| `enable_cdm_storage_id`, `alternate_cdm_storage_id_key` dropped | the storage id needs RLZ's machine id, which Linux doesn't have (`cdm_storage_id.cc` builds it on Windows, Mac and ChromeOS only); Chrome for Linux has none either | — |
| added: `use_sysroot=true`, `is_clang=true`, `use_kerberos=false`, `use_system_libffi=false`, `use_vaapi=true`, `rtc_use_pipewire=true`, `blink_enable_generated_code_formatting=false` | helium-linux's `flags.linux.gn`, minus its official and siso lines (the Mac list and siso's default cover those) | keep |

Kept: proprietary codecs (`ffmpeg_branding="Chrome"`), Widevine's build flag, no Google API keys, Safe Browsing mode 0,
no reporting, no field-trial config, no updater, no background mode, not a component build, `exclude_unwind_tables`,
and `branding_file_path` (`//chrome/app/theme/ardia/BRANDING`).

**Widevine** is an opt-in setting on Linux, off by default ("Play DRM-protected content", as Firefox does it; the
owner's decision). The component updater is security-only (`chromium-component-updater-security-only.patch`), as on
the Mac; `chromium-linux-widevine-component.patch` lets Widevine's component (`oimompecagnajdejgnnjijobebaeigek`) through
only while the local-state pref `component_updater::kArdiaPlayProtectedContentPref` (`ardia.play_protected_content`,
declared in `widevine_cdm_component_installer.h` and registered with the component updater's prefs) is on. The app's
settings set it (`g_browser_process->local_state()->SetBoolean(...)`); the engine reads it before the installed
component is read and follows its changes:

- **Off** (the default): the update client never sees the component, so nothing is fetched; an installed CDM's
  `ComponentReady` doesn't write the Linux hint file, and the hint file is deleted, so no Widevine CDM loads at the next
  start.
- **Turned on**: `MaybeThrottle` (the component updater's public on-demand call, with its cooldown) fetches the
  component from Google, and an installed one is hinted again. Linux loads the CDM at startup, before the zygote is
  locked down, so DRM plays from the next start: the setting's copy should say so.

The pref is local state, so it holds for every profile. Compiled (`chrome/browser/component_updater:impl`,
`components/component_updater`); not exercised yet: the UI has no setting for it, and fetching it reaches Google.

## Packaging

`06-package.sh` packs an out dir the way Chromium's CI packs its Linux snapshot: the files and folders of the
`chrome-linux.zip` archive in `infra/archive_config/linux-archive-rel.json`, under one top folder, as
`ardia-chromium-linux-x64.tar.xz` (a tarball keeps the executable bits and symlinks), with `RUN.txt`, and `SHA256SUMS`
beside it. `package_linux.py` checks the files against `gn desc out/Release_GN_linux_x64 //chrome:chrome runtime_deps`
and writes what differs to `~/chromium-build-linux/package/x64/missing-runtime-deps.txt`.

The `chrome` binary, built with `symbol_level=1`, is 1.74 GB with its debug info. `package_linux.py` packs every ELF
file from a staged copy run through the tree's own `llvm-strip --strip-debug`: the symbol table stays, so a stack still
names its functions, and the out dir keeps the full binary for debugging.

`chrome_sandbox` (the setuid fallback sandbox) is in the archive config but isn't built with `chrome`; the app's own
package (`.deb`, AppImage) is the next step and carries the sandbox story ([Running it](#running-it)).

## Running it

On 2026-11-15, the `chrome` above (before the layer), on a private Xvfb (display 130) with its own D-Bus session bus
(`scripts/linux/xvfb 130 -- ...`), a throwaway `--user-data-dir` in `/tmp/claude-1000/linux-engine-build/` and
`--remote-debugging-port=9330`:

- **The sandbox.** Without `--no-sandbox` it stops at once: "No usable sandbox!". This machine has
  `kernel.apparmor_restrict_unprivileged_userns=1` (Ubuntu 23.10 and later), so only binaries an AppArmor profile names
  get user namespaces, and there is none for this path; the setuid `chrome_sandbox` isn't installed (it needs root to be
  setuid). Everything below ran with `--no-sandbox`. A package installs one of the two: an AppArmor profile with
  `userns` for its binary (as `/etc/apparmor.d/chrome` does for Google Chrome) or the setuid sandbox.
- **CDP.** `Browser.getVersion`: `Chrome/157.0.8103.50`, V8 15.7.112.23, user agent `... Chrome/157.0.0.0 Safari/537.36`
  (the reduced user agent, as Chrome's).
- **`chrome://version`**: "Ardia 157.0.8103.50 (Developer Build) (x86_64)", "Chromium 157.0.8103.50", OS Linux, the
  Ardia mark at the top right, "The Chromium Authors" (`brand-namesub` puts that back), `--ozone-platform=x11` added by
  Chrome under X. Screenshot over CDP (`Page.captureScreenshot`), looked at.
- **A page loads**: `scripts/linux/fixtures/smoke.html` as a `file://` URL, title "Ardia smoke page", rendered (screenshot
  looked at).
- **Helium's services stay off**: the only request to a Helium endpoint in the log is the spellcheck dictionary, to the
  unresolvable `services-disabled.qjz9zk`, and Chrome's URL blocker refused it.
- **The leak check** (`check-build.sh`, the Mac's `helium-check-build.py` over a scratch view of the out dir laid out
  as a framework: the binary and every pak): 693,962 resources in 232 paks; no Helium uBlock Origin, onboarding page,
  non-free search data or Helium host; 8 resources still say Helium (Windows' count too). 8 s.

## What failed and how it was fixed

In the order they happened on 2026-11-15:

1. **The scratch-tree check refused the tree**: Debian's sysroot has hard links between Mesa's DRI drivers. Fixed in
   `03-helium.py` (above): hard links are allowed inside the sysroot when every link of each file is there.
2. **`brand-namesub` refused a string**: helium-linux's `add-error-for-missing-desktop-file` adds a Settings string that
   names `helium.desktop`. The patch is skipped (above). Step 3 refuses a tree it has started on, so the tree was reset
   first: the 192 files Helium's patches had created in `src` (every untracked file there, checked against the files
   the series' patches create) were deleted, `.helium-stages-src` and `domsubcache.tar.gz` were set aside, and
   `01-sync.sh` ran again (`gclient sync --reset --force` and the forced checkout of the tag revert every repo's edits;
   29 s).
3. **`engine/chromium/apply.sh` needs `rsync`**, which the machine doesn't have. Added to `host-tools.sh`.
4. **`chromium-helium-branding.patch` didn't apply** in `helium_flag_{choices,entries}.h`: the `except` line and
   `chromium-linux-helium-flags-branding.patch` (above). The other 79 patches had gone in on the first run, so the
   branding patch went in after them; with `git apply`'s exact context the result is the same as in order.
5. **The first `05-build.sh` was started under the Bash tool**, which stops a command after two hours. It was stopped
   (with `pkill -f`, which also matched the starting shell and left the bindings step's siso running without the lock;
   those processes were stopped by pid) and started again detached.

## Resuming

Everything stays on the build machine: the checkout, the Helium checkouts, `host-tools/` and `out/Release_GN_linux_x64`.
With the scripts in a clone of this repo:

```
setsid nohup scripts/linux/engine/05-build.sh --apply >/dev/null 2>&1 </dev/null &
scripts/linux/engine/check-build.sh
scripts/linux/engine/06-package.sh --apply
```

The build is incremental: a rerun compiles only what is left. Never delete or clean the out dir and never run `gn
clean`; a full build costs about 2 h 45 min here. Steps 1 to 4 never need to run again on this tree; step 3 refuses a second run
(`.helium-stages-src`), and step 4 skips what is applied (rerun it after changing the series, a layer or `linux-hooks`,
then step 5). To start over on a new Chromium version, follow the Mac's "Moving to a new Chromium version"
(`docs/engine-build.md`) with `~/chromium-build-linux` and the pins in `helium-pins.ini` here.
