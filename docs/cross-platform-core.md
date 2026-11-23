# One core, two hosts

Ardia runs one browser UI on three platforms today. Below the UI boundary it runs three hosts with three native layers:

| | macOS | Linux | Windows |
| --- | --- | --- | --- |
| UI runtime | React Native macOS | Chromium `chrome://ardia/` WebUI (`apps/linux`) | React Native Windows (`apps/browser/windows`, `packages/expo-windows`) |
| Host code | Swift pods + `engine/ardiacore` (Objective-C++) | `engine/ardiacore-linux` (C++) | RNW C++/WinRT modules + `scripts/windows/engine` (C++) |
| JS → native | Expo modules, `CallTable` | `chrome.send("ardiaRequest")`, `kRoutes`, `ShellHostView::Invoke` | RNW turbo modules, `forwarded.json` |
| Engine call registry | dlsym of `ac_*` | `gen_engine_dispatch.py` table | `series_win.py` `ac_calls.cc` |

So sync, import, plugin policy, updater checks, the engine call map and most of the Chromium host are written more than once. This doc is the plan that brings it down to **one shared core and two hosts**:

- **macOS host:** React Native macOS + Swift + `engine/ardiacore`. Kept for AppKit feel, Liquid Glass, cold start and WebKit.
- **Desktop host:** the Chromium `chrome://ardia/` WebUI host, serving **Linux and Windows** from one frontend (`apps/desktop`) and one C++ host (`engine/ardiacore-desktop`), with thin Linux and Win32 delegates.

The four tracks below are one design. Each track only targets those two hosts, so no track writes code for React Native Windows that Track 4 then deletes.

## The layers

```
apps/browser/src, packages/*/src          shared UI and state (TypeScript), unchanged
packages/hostapi                          the host API schema and its generator (Track 3)
  ├─ generated TS clients                 packages/*/src/**/generated
  ├─ generated Swift call tables          packages/*/ios/**/generated
  └─ generated desktop routes             engine/ardiacore-desktop/**/generated
packages/core-rs                          shared Rust core, C ABI (Track 1)
  ├─ ardia-crypto                         AEAD/HKDF/HMAC/Ed25519, RustCrypto or BoringSSL backend
  ├─ ardia-sync-core                      vault format, keys, recovery phrase
  ├─ ardia-import-core                    browser data parsers
  ├─ ardia-update-core                    signed manifest checks
  └─ ardia-ffi                            extern "C" + cbindgen header
engine/chromium                           Chrome services as ac_* calls, all platforms (Track 2)
engine/ardiacore-desktop                  WebUI host shared by Linux and Windows (Tracks 2, 4)
engine/ardiacore-linux                    Linux delegate: Ozone, D-Bus, XDG, libsecret
engine/ardiacore-win                      Win32 delegate: frame, DWM, DPAPI, toasts, installer
engine/ardiacore                          macOS: AppKit only
```

## Engine keys are the first constraint

`engine/engine-key.py` hashes everything under `engine/`, minus what it can prove belongs to the other platform. It knows two platforms, and GN conditions it can't read (`is_win`, `is_linux || is_win`, `!is_win`) count toward both keys. A Mac key move means a Mac engine build, which runs only on the Mac mini's incremental tree, and a new framework for every agent's next build.

So the first change is tooling. It changes no artifact, and it must not move a published key:

- **Additive, not a rewrite.** `series.py` and every shared `BUILD.gn` are hashed inputs, so editing the parser or a condition moves both keys (`engine-key.test.mjs` asserts exactly that for `series.py`). The Mac and Linux keys keep today's input projection unchanged. Windows is added beside them as a third projection with its own selector handling.
- **History, not only HEAD.** Nearest-prebuilt lookup (`scripts/linux/fetch-engine.sh`, `mac.yml`) recomputes keys of published revisions with today's code. The test serializes the key inputs and `--paths` for HEAD and for every revision pinned in `prebuilt-engines*.tsv`, and requires them byte-identical before and after.
- **A key for the build Windows actually runs.** `series_win.py` selects `all` and `mac` lines, applies its own ordered patches and skips, rewrites `BUILD.gn`, and copies inputs from outside `engine/` (`EngineApi.h`). The Windows key hashes that plan's materialized inputs. A test proves the old and new Windows plans produce the same inputs. `prebuilt.json` keeps its source commit for release provenance and gains the key.
- **Then selector sets.** Once the three projections are pinned, series lines and layers can take `linux,win`, and GN conditions such as `is_linux || is_win` parse into platform sets. A new `linux,win` line moves the Linux and Windows keys only. The Linux syntax checker and the Windows GN checker learn the same selectors, and the AGENTS.md rule that kept Windows sources in `scripts/windows/engine` is retired.

After that, the rule for every later change is:

| Where the change lands | Keys it moves | Build it needs |
| --- | --- | --- |
| `engine/ardiacore` | mac | Mac mini, incremental |
| `engine/ardiacore-desktop` (`linux,win`, after selector sets) | linux, win | Boat builder for Linux; `~/chromium-build-win` for Windows |
| `engine/ardiacore-linux`, `engine/ardiacore-win` | that one | that one |
| `engine/chromium` | all | all; batch these |
| `packages/core-rs` (via `copies.tsv`) | linux, win | as above; macOS links it into the pods instead |
| `packages/hostapi` and its generated TS and Swift | none | app build only |

## Track 1: the shared Rust core

**What moves.** Logic that has no OS in it and is written three times:

- **Sync** (first). The vault format is already byte-compatible on macOS, Linux, Windows and Android: `NNS1` magic, HKDF-SHA256 info strings `file-key`, `name-key`, `password-key`, `password-nonce-key`, AES-256-GCM with the `NNS1 + "<chain>/<scope>/<file>"` associated data, u32be length + 1024-byte padding, the deterministic password nonce, base32 folder tags, BIP39 English with 4-letter prefixes (`docs/sync.md`). Rust replaces `SyncCrypto.swift`, `RecoveryPhrase.swift`, `Wordlist.swift`, `ac_linux_sync_{crypto,wordlist,json}.cc` and later the Kotlin copy. Keychain, libsecret and DPAPI key storage stay native.
- **Import parsers.** Netscape HTML, CSV, Chromium bookmarks and search engines, SNSS sessions, Firefox and Zen session JSON, Arc and Dia sidebars, ZIP, Firefox key4/PBE/JWE, Chromium v10/v11 blobs once the key is known. The output is the existing `ImportResult` JSON. Discovery, the OS key unlock (Keychain safe storage, libsecret/KWallet, DPAPI), Safari Full Disk Access and SQLite snapshots stay native.
- **Update manifest signatures.** Ed25519 over the manifest. Linux checks one today in a shell script; Windows checks only an unsigned SHA-256 and gets the check for the first time.
- **Plugin policy.** Fetch policy, URL parsing, archive and pin checks, storage limits and budgets out of `packages/shell/ios/PluginCore`, shared with `packages/plugin-broker`'s QuickJS host. This happens when the desktop host gets a plugin manager, not before. `packages/plugin-broker` joins the same CI job now so it stops rotting.

**Not moved:** crash dump parsing (each platform's format differs, 56 shared lines on Linux) and config/document I/O (mostly file calls). They don't repay a boundary.

**ABI.** One `extern "C"` surface, `ardia-ffi`, with a header generated by cbindgen and committed (`packages/core-rs/include/ardia_core.h`). CI runs `cbindgen --verify`. Two of three consumers are C++ and Swift imports C directly; UniFFI has no first-party C++ output. Rules:

- Opaque handles and `(ptr, len)` byte buffers. Every buffer Rust returns is freed by `ardia_buf_free`, which zeroes it first. Secrets are `zeroize`d on the Rust side.
- Structured results cross as JSON, which every host already hands to JS.
- `panic = "abort"`, no globals, no threads, no I/O. Callers pass bytes in and get bytes out.
- Every function returns an `ardia_status` enum; errors carry a stable code string.

**Crypto backends.** `ardia-crypto` is a trait with two implementations behind cargo features:

- `rustcrypto` (aes-gcm, hkdf, hmac, sha2, ed25519-dalek) for the cargo builds that macOS, iPhone, Android and CI link.
- `boringssl` (`//third_party/boringssl:bssl_crypto`) for the GN build inside Chromium.

**Builds.**

- **macOS and iPhone.** `scripts/core-rs/build-xcframework.sh` builds `ArdiaCoreRS.xcframework` (`aarch64-apple-darwin`, `aarch64-apple-ios`, `aarch64-apple-ios-sim`). `ArdiaSync.podspec` vendors it, and `packages/sync/Package.swift` uses it as a `binaryTarget` for `swift test` and `PhoneSync`. The Swift `SyncKeys` API stays as a thin wrapper, so `SyncVault` and the phone code don't change.
- **Linux and Windows (inside Chromium).** A GN `rust_static_library` on Chromium's own toolchain with the `boringssl` backend, copied in through `copies.tsv`. A cargo-built staticlib can't link into `chrome`: it would bring a second Rust standard library. Only crates Chromium already vendors are used on this path (`serde_json`, `base64`, `zeroize`, `zip`); the crypto comes from BoringSSL, which is why the backend split exists.
- **CI.** A `core-rs` job on macOS, Linux and Windows runs `cargo fmt --check`, `clippy -D warnings`, `cargo test` and `cbindgen --verify` for `packages/core-rs` and `packages/plugin-broker`.

**Compatibility gate.** Every switch is gated on frozen vectors: `packages/sync/tests/fixtures/sync-vectors`, `sealed-0.2.32.b64`, both `windows-interop` sets and the Kotlin vault. The Rust crate must reproduce every committed fixed-nonce byte and open every random-nonce vault before any host links it.

The framing already matches everywhere. Recovery phrase *parsing* does not: Swift splits on Unicode lowercase letters, Windows on Win32 character classes, Linux on ASCII with a hand-kept separator list, so an emoji between two words separates them on the Mac and joins them on Linux. Linux also caps a password field at 65,535 bytes. Rust follows Swift, the reference shipped on Mac and iPhone; a frozen table records each platform's current answer for the divergent inputs, so each host switch states which inputs change.

**Gates before a host switches.** The same vectors run against the GN target with the `boringssl` backend on Linux and Windows (Chromium's rustc 1.101 nightly and LLVM 24, not local cargo's) before either C++ copy is deleted. The Apple framework reaches the Mac pods, `swift test` and the iPhone's `ArdiaKit` package before the Swift copy is deleted. The Swift wordlist stays until `test_sync.py` and `packages/sync/scripts/e2e.mjs` stop reading it. Each final link holds one Rust archive, and its exported symbols are checked.

## Track 2: one Chromium host

Today `engine/chromium` holds the services (`ac_*`), and each platform reimplements tab lifecycle, prompts, find, cast, autoplay, devtools authority, the page channel and host visibility on top. Two of those three hosts are Views/Aura (Linux and, after Track 4, Windows), so the split is:

- **`engine/chromium`** keeps the services and gains the cores every platform shares: the prompt model, find, the cast sink model, the autoplay decision, devtools authority, the host visibility contract, the browser side of the page channel, and **one generated call registry** replacing dlsym-by-name, `gen_engine_dispatch.py` and `ac_calls.cc`.
- **`engine/ardiacore-desktop`** is the Views host: `ShellHostView`, the `chrome://ardia` data source, the WebUI bridge and its trust check, viewports and input regions, glass, the session and documents services, notifications, downloads, report and crash. Most of it moves out of `engine/ardiacore-linux` unchanged, starting with the files that are already platform-neutral (`*_policy.h`, `*_core.cc`, `document_reducer`, `tab_policy`, `sync_json`, `cast_core.h`, the geometry headers).
- **Delegates.** `ac_desktop_platform.h` is the interface the desktop host calls for anything OS: secrets, reauth, default browser, login item, calendar, location, power, open external, self update, window decorations. `engine/ardiacore-linux` and `engine/ardiacore-win` implement it. Inside the Chromium binary this is a C++ interface; the C ABI (`ac_engine_call`, `ac_engine_set_event_sink`, `ac_host_set_delegate` with a sized v1 struct) is only needed at the Mac pod's boundary.
- **Hooks.** The `g_ardia_linux_*` and `g_ardia_win_*` hook names (autoplay, devtools) become neutral `g_ardia_desktop_*` names in a desktop hooks header, not in `ac_hooks.h`, which would move both keys. Of the two autoplay implementations, the Windows one (Blink commit parameter) is kept.
- **Patches.** About 30 of the 35 `linux` patches change only Views, browser or content code behind `IS_LINUX`. Widening those guards to `IS_LINUX || IS_WIN` makes them `linux,win` patches. The Ozone, GTK and Wayland ones stay `linux`.

Changes under `engine/chromium` move the Mac key, so they are batched: one Mac engine build per group, on the Mac mini, coordinated for the mini's chromium lock.

## Track 3: the host API schema

Each native method is wired by hand in up to six places: the Swift call table, `api.ts`, the Linux `kRoutes` and invoke chain, `bootstrap.js` deadlines, `forwarded.json` and the RNW module. Three of those already restate the same verb → service map (27 Mac `passing` rows, 36 Linux routes, 24 Windows forwards; 20 are identical everywhere).

`packages/hostapi` holds the schema as TypeScript values, read by Node's built-in type stripping, with payload types referenced by name from the packages that already define them (so the ~100 payload types are never restated):

```ts
export const history = defineDomain({
  calls: {
    query: { args: "Profile & HistoryQuery", result: "HistoryPage", service: "ac_history_query" },
  },
  events: { changed: "HistoryChangedBatch" },
  imports: { "../history": ["HistoryQuery", "HistoryPage", "HistoryChangedBatch"] },
});
```

A call's bindings default to `service` on every host; a host that needs code says so (`mac: "custom"`, `desktop: "typed"`). `generate.mjs --write | --check` emits, byte for byte deterministic:

- **TS:** `packages/ardiacore/src/engine/generated/<domain>.ts` (`<D>Calls`, `<D>Events`), merged into `EngineCalls` (the `engine` domain's own types are imported as `EngineDomainCalls` and `EngineDomainEvents`), and `generated/manifest.json`, which the existing drift tests (`api.test.mjs`, `test_contract.py`, `hostContract.test.mjs`) read instead of regex-parsing source.
- **Swift:** a fully service-backed domain gets its whole `<Domain>Module.swift`; a mixed one gets `<Domain>Calls.swift` with a handler table merged into `CallTable`.
- **Desktop host:** `ac_desktop_routes.h` (routes, capabilities) and the `bootstrap.js` deadline map. Emitted once Track 2's desktop layer exists, so Linux and Windows share it from the start.
- **No React Native Windows output.** Until the cutover, Windows only gets a check that `forwarded.json` agrees with the schema.
- **Events** carry the same per-host bindings as calls (`forward`, `custom`, `absent`) and the engine `topic` when it differs from the event's name, so the Mac's `ForwardedTopics`, Linux's `EventName` and Windows' `topics` are each checked exactly against the schema.

Later the schema gains `module` domains (positional Expo functions: shell, sync, import, shaders) that emit the TS `*Native` interfaces and the desktop invoke table, with Swift bodies behind a generated protocol. The Rust core's FFI surface is described in the same schema when sync and import calls move.

Generated files carry no header comment (the repo's no-comments rule); the `--check` test in `pnpm test` is the guard, and `checks.yml`'s `code` paths filter includes every generated target.

## Track 4: Windows on the desktop host

Windows stops running React Native Windows and runs the Linux host's model: Chromium is the app and serves the shared UI from `chrome://ardia/`. What stays Windows-only is what Chrome itself keeps on Windows:

| Windows needs | Comes from |
| --- | --- |
| Mica backdrop, rounded corners, snap layouts flyout | DWM attributes on the widget HWND; `WM_NCHITTEST` → `HTMAXBUTTON` over the shell's maximize rect |
| Secrets | DPAPI delegate (os_crypt already uses it); one-time migration of Credential Manager items |
| Notifications | Chromium's toast bridge with the app's AUMID |
| Default browser, Run key, file icons, lock and sleep signals | Win delegate |
| Installer and updates | Inno Setup kept; the updater delegate checks the Ed25519 manifest from Track 1 |
| Launch guard, relaunch, install names, reauth window, external protocol dialog | kept Windows patches |

Deleted with RNW: `FocusHold`, key holds, text-revert repair, the JS animation driver, `WindowFade`, `ModalThread`, page holes and covers, `frame_view.cc`, CDP-injected Peek, `FileDrop` (HTML drag and drop works in a WebContents), `IntroMusic` (the shell's `<audio>`), and the `hosted-*`, `app-in-browser-process`, `app-message-pump` and `child-window-activation` patches. That is the class of bug behind #2097, #2570, #2574 and #2197.

**The frontend.** `apps/linux` becomes `apps/desktop` with `src/platform/{linux,win}`; Vite builds `--mode linux` or `--mode win`, resolving `.win.ts` before `.desktop.ts`. Most of its ~190 files are desktop-generic already (transport, shims, viewports, glass, session, menus, window controls). Linux-only: tiling, GTK button layout, keyring/polkit wording, EDS calendar, tarball self-update, sandbox notice. Windows wording comes from the existing `*.windows.ts` terms.

**The hard part is startup and native input, so it is proven first.** Chromium on Windows is Views/Aura (`DesktopWindowTreeHostWin`), but the Linux host still calls Ozone and Wayland directly, and the `window-state` patch mixes Views changes with Wayland code. Windows installs its RNW hooks before Chromium starts, and the profile launch guard runs after the RNW DLL check. So before any patch is widened or the host moved, a **pilot** proves one WebUI window on Windows with a real page: focus and keyboard handoff between the shell and the page, DPI-aware hit testing over the caption and resize edges, snap, and close and relaunch, with shell selection (`--ardia-shell=webui`) and profile protection decided explicitly before RNW is touched.

**Never break current users.** Until the cutover PR, the shipped Windows build is the RNW one, and Bonzai's and the team's RNW fixes keep landing (the Hermes crash fix on `windows-next`, #2540, included). The WebUI build arrives behind `--ardia-shell=webui` with its own profile directory, and a non-blocking CI job runs the Linux acceptance tour over CDP plus the existing Windows real-input tour. CDP covers WebUI flows, not native window behavior.

**Cutover is an upgrade, tested as one.** A restartable one-time migration covers `%LOCALAPPDATA%\Ardia` (session, documents, placement), `%APPDATA%\Ardia` config, `Sync\sync-key-*.dpapi`, and Credential Manager items, which can span several chunks. Chromium's `User Data` and the install identity stay where they are. An installed upgrade from the last RNW alpha with populated data must keep cookies, saved passwords, extensions and the sealed local sync state, and a rollback to the RNW build must still open that data. The existing installer and real-input checks are required before cutover. The deletion PR comes after.

## Order

Each item is one PR closing one issue. Items on one line can run in parallel.

The order is built around two integration proofs, the Windows WebUI pilot and the Rust GN link, which run early and in parallel with the tooling.

1. **Design** (this doc). **Engine key: an additive Windows projection**, Mac and Linux keys and their history unchanged. **Rust core: workspace, `ardia-crypto`, `ardia-sync-core`, `ardia-ffi`, vectors and the divergence table**, plus CI for it and `plugin-broker`. **Host API: schema, generator, `history`**, zero behavior change.
2. **Proof: Rust GN link.** The `boringssl` backend as a GN `rust_static_library`, running the vectors on Chromium's toolchain (Linux engine build; nothing switches yet). **Proof: Windows WebUI pilot** behind `--ardia-shell=webui` (Windows engine build). **Engine key: selector sets** (`linux,win`). **Host API: bookmarks, favicons**, then **the remaining service-backed domains** (downloads, engine, extensions, permissions, search, sites, tabs) with per-host event bindings and Linux route reply fields.
3. **macOS and iPhone link the Rust sync core** (Apple framework; Swift crypto and phrase deleted). **Linux links it** through GN (its C++ sync crypto and JSON deleted). **`engine/ardiacore-desktop` layer**, extracted against both hosts, with `ac_desktop_platform.h` and the Linux and Win delegates.
4. **Windows desktop host completed** (Win delegate, wording, Mica, snap, CI job). **Generated desktop routes. Ed25519 update manifests.** **`apps/linux` → `apps/desktop`**, when Windows needs the platform folders.
5. **Windows cutover** after a verified installed upgrade and rollback, then **RNW deletion**.
6. Later, each when it unblocks a tested slice: **Rust import parsers** (one format per PR), **shared cores into `engine/chromium` and one call registry** (batched Mac engine builds), **plugin policy**.

## What to watch

Every switch ships with the telemetry that shows it working: `sync_core` (`backend: rust|native`, open failures by code), `import_core` per format, and `host_shell` (`webui|rnw`) on Windows. A vault that fails to open after a switch is the regression these catch; the vectors gate it before release.
