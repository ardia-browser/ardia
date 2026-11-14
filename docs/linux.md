# Ardia on Linux

The Linux port shares the Mac's and Windows' TypeScript UI (`apps/browser/src`, `packages/*/src`) and is laid out like
the Windows port (`docs/windows.md`): an app project under `apps/browser/linux`, an `expo-modules-core` replacement in
`packages/expo-linux`, platform files named `*.linux.ts(x)` beside the shared ones, scripts in `scripts/linux`, CI in
`.github/workflows/linux.yml`. The work lands on the `linux` branch of the fork, which starts from the Windows branch
(PR #1116) so the shared platform layer (`lib/platformFeatures`, `lib/platformChrome`, `lib/platformTerms`,
`platform/windowControls`, the app-drawn window buttons) serves both.

## Design

| Layer | Linux |
| --- | --- |
| Process and engine | Electron (Chromium + Node), `apps/browser/linux` |
| UI | The shared TypeScript, bundled by Vite for the browser with `react-native-web`, run in one renderer |
| `expo-modules-core` | `packages/expo-linux`: native modules are the main process's, reached through the preload bridge |
| Pages | Electron `<webview>` elements inside the UI's DOM, one per tab, partition `persist:<profile>` |
| Windows | Frameless `BrowserWindow`s, each a child the one UI runtime opened and renders into |
| Chrome services | Written in TypeScript in the main process (history, bookmarks, favicons, passwords, autofill, content blocker, extensions, import) |

### One runtime, many windows

The Mac and Windows run one JS runtime that mounts a root per window. On Linux one hidden `BrowserWindow`, the host,
loads the UI bundle. Every app window (browser, Little Ardia, Settings, Import) is opened from the host with
`window.open('about:blank', <windowId>)`: Electron keeps it in the host's renderer process and same origin, so the host
mounts a React root into the child's document, and every window shares the one zustand store. The main process
shapes those windows in `setWindowOpenHandler` (frameless, transparent, sizes from `ArdiaAppWindows.openWindow`).
Closing a window unmounts its root. The host is never shown and lives until quit.

`ArdiaAppWindows.openWindow` (`packages/expo-linux/src/windows/appWindows.ts`) asks main to shape the window
(`shapeWindow`, in `apps/browser/linux/src/modules/appWindows.ts`), opens it, mounts `AppRegistry.runApplication("main",
{ windowId })` into its `#root`, and asks main to show it after the first paint (fading in when `animated`). Closing
unmounts first, then main closes it; a window closed by the window manager asks the UI first (`closeRequest`) for
browser and Little Ardia windows. When the last app window closes, main runs the quit handshake (`willQuit`,
`replyToTerminate`). Windows are rounded (12 px, a 1 px edge) except maximized or full screen;
`windowCornerRadius()` is the Mac's 19 so the page card keeps Dia's 10 pt radius.

`react-native-web` gives each window's document its own copy of its style sheet; other `<style>` and stylesheet links
in the host's head are mirrored and kept in sync (`host/documentStyles.ts`). `host/acrossWindows.ts` makes the host
answer for its windows: listeners added on the host's `window` or `document` for input, focus, resize and scroll are
added to every app window too (react-native-web's responder system, `Pressable`'s key handling and the UI's own
listeners need no changes), `document.activeElement`, `hasFocus()`, `visibilityState` and `getSelection()` read the
focused window, `ResizeObserver` and `IntersectionObserver` observe each element with its own window's observer
(`onLayout` depends on it), and `instanceof Node`/`Element`/`Event` accept objects from any app window.

Native views are drawn in the DOM (`packages/expo-linux/src/views/registry.tsx`, most ported from the web demo):
`Symbol`, `Surface`, `VisualEffect` (nearly opaque: a transparent Linux window can't blur the desktop), glass, popover
bubbles, `FadeLabel`, the spinner, the pager's `SwipeArea`, the GL backdrop and power-up (with CSS fallbacks where WebGL2
is blocklisted), and `WindowDragRegion`, which moves the window from main by following the cursor (so it also works
without a window manager); a double-click maximizes. The engine's views (`ArdiaWebView`) come from
`engine/modules`' `engineViews`. A text field taking or losing focus is reported to main
(`ArdiaFocus.setTextInputFocused`) for the shortcut table; `claimFocus` and the key-responder calls take DOM nodes and
stay in the renderer. Linux uses the Windows chrome (app-drawn window buttons), keys and copy wording through
`*.linux.ts` files that re-export the Windows ones, and its own `platformFeatures.linux.ts` and `platformTerms.linux.ts`.

### Pages are `<webview>` elements

`ArdiaWebView` (`packages/expo-linux/src/engine`) renders a `<webview>` in place, so the UI draws over pages, clips
their corners and animates them like any other element. Each page lives in a registry keyed by its tab id
(`engine/pages.ts`); the element is made by the document of the window that shows it, never the host's: a webview the
host made draws in another window but sits in the host's frame tree, so it gets no input.

- **Moving without reloading.** Removing a `<webview>` from the DOM destroys its page. Every app window gets a tiny
  preload (`window-preload.js`, from `engine/hostPreload.ts`) that adds a `connectedMoveCallback` to the window's
  `<webview>` definition before Electron defines it, and moves use `moveBefore`, which then keeps the page alive. Pages
  parked for a hand-off (`ArdiaTabs.prepareTransfer`) wait in a hidden lot in their window; React's reorders are routed
  through `moveBefore` too (`engine/pageMoves.ts`). A page moving to another window can't move its element: the new
  element starts with no navigation (`about:blank#ardia-restores-history`, dropped in `will-attach-webview`) and gets
  the old page's history, scroll state included, through `navigationHistory.restore`.
- **Hidden tabs** keep their element (`visibility: hidden`); the page reports `document.hidden` as in Chrome.
- **Main side** (`apps/browser/linux/src/engine`). `sessions.ts` sets each page's web preferences in
  `will-attach-webview` (sandboxed, not transparent, the page preload) and sets up each partition once: profile
  `persist:ardia[-<profile>]`, private profiles `ardia-private-<profile>`, Chrome's user agent without "Electron".
  `guests.ts` tracks every guest and sends its events to the renderer as `ArdiaLinuxPages` `page` events keyed by
  `webContents` id (navigation state, progress, favicons, theme colour, find, zoom per host, audio, full screen, crashes,
  load and certificate errors, status text); the renderer attaches each guest to its tab (`ArdiaLinuxPages.attach`).
  `pageCalls.ts` answers the view's imperative methods (`ArdiaLinuxPages.page(id, method, args)`). The page script
  (`packages/ardiacore/ios/page_script.js`) runs in each page's main world from a sandboxed preload
  (`page-preload.js`); `pageScriptBridge.ts` handles its messages (theme, scroll, selection, now playing, badges,
  notifications, Peek and split links). The same preload replaces `alert`/`confirm`/`prompt` with a synchronous ask to
  main, which shows them over the page's own window (`pageDialogs.ts`).
- **Opening.** Links that open tabs become `openWindow` events; `window.open` with a size opens an Electron window that
  keeps its opener (sign-in popups). Downloads (`downloads.ts`) report to the downloads panel; a test instance saves
  into its data dir. Permission prompts (`permissions.ts`) read and remember through `services/sites.ts`; external
  protocols ask through the page's `externalApp` prompt. The page context menu is a native menu.
- **Widevine.** The `electron` package is castlabs' Electron for Content Security (`github:castlabs/electron-releases`,
  the `+wvcus` build nearest our Electron), a drop-in Electron with Widevine. `engine/widevine.ts` calls
  `components.whenReady()` at startup, which installs or updates the CDM under `<data>/Engine/WidevineCdm` (about a
  second the first time) and logs its version to `launch.log`. Linux has no VMP signing, and Chrome on Linux needs none:
  Widevine L3 plays (the shaka demo's Angel One stream, checked); services cap Linux at their L3 resolution as they do
  for Chrome. `package.mjs` downloads other architectures from castlabs' releases. After `pnpm install`, run
  `node node_modules/electron/install.js` if `node_modules/electron/dist` is missing.
- **Not on Linux:** geolocation (no location provider key), tab discarding, Picture in Picture controls beyond the
  page's own, and casting. Calls not implemented fail with `ERR_ENGINE` and log once.

### The bridge

`apps/browser/linux/src/preload.ts` gives the host renderer `window.ardiaLinux`:

```ts
type LinuxBridge = {
  modules(): Record<string, { sync: string[]; async: string[]; constants?: Record<string, unknown> }>;
  callSync(module: string, method: string, args: unknown[]): unknown;
  call(module: string, method: string, args: unknown[]): Promise<unknown>;
  callSyncRaw(module: string, method: string, args: unknown[]): { value?: unknown; error?: string; code?: string };
  callRaw(module: string, method: string, args: unknown[]): Promise<{ value?: unknown; error?: string; code?: string }>;
  onEvent(listener: (module: string, event: string, payload: unknown) => void): () => void;
};
```

`contextBridge` copies an error thrown in the preload without its own properties, so a `code` set there never reaches
the UI. `packages/expo-linux` therefore calls `callSyncRaw`/`callRaw`, which hand back the main process's reply as it
is, and throws in the UI's world: a `NativeCallError` with the main error's message and `code` (`ERR_ENGINE`, …, or
`ERR_LINUX_NATIVE` when main gave none), plus `module` and `method`. `callSync`/`call` still unwrap in the preload for
code that only needs the value.

Main-process modules live one per file in `apps/browser/linux/src/modules/<Name>.ts` and register with
`defineModule(name, { sync, async, constants })`. A module emits events with `emit(module, event, payload)`, which
reaches JS as `emitNativeEvent(module, event, payload)`, the same channel the Mac's `addListener` uses. In
`packages/expo-linux`, `requireNativeModule(name)` answers each property in this order: a TypeScript wrapper around
the main method where one is needed (`aroundMain` in `tsModules.ts`), the main process's module (sync methods through
`callSync`, async through `call`), modules written in TypeScript (`writtenInTs`), the engine's modules, the services',
`defaults.ts`, then an inert method that logs its name once (`ardiaLinuxMissing()` in the console lists them).

## The main process

- **Launch config.** `src/launch.ts` and `src/paths.ts` are the only files that read the environment (`ARDIA_DATA_DIR`,
  `ARDIA_BACKGROUND`, `ARDIA_REMOTE_DEBUGGING_PORT`, `ARDIA_INSTANCE`, `ARDIA_SWITCHES`, `ARDIA_TRACE`, `ARDIA_TEST`,
  `ARDIA_FEEDBACK_URL`). A test instance is an `ARDIA_DATA_DIR` outside `~/.local/share/ardia` and `~/.config/ardia`;
  only there do `ARDIA_TEST` and `ARDIA_TRACE` count. Linux adds the trace area `keys` (every key press, its
  webContents and window). The main process logs to stdout and `<data>/launch.log`.
- **Documents.** `ArdiaDocuments` stages each write in memory (a read right after sees it) and lands it with an
  atomic replace (temp file, fsync, rename), one at a time, retrying with backoff; quitting flushes synchronously.
- **Quit.** `before-quit`, SIGTERM, SIGINT and SIGHUP emit `willQuit`; the UI saves and answers
  `ArdiaAppWindows.replyToTerminate`, and Ardia exits, or exits anyway after 3 s (`src/quit.ts`).
- **Keyboard shortcuts.** The Windows command table, ported (`src/menus`), runs on `before-input-event` of every
  webContents, with Ctrl where the Mac has ⌘ and the user's remapped shortcuts. A `<webview>`'s keys arrive at the
  page's and the host's webContents, so they go to the page's window (`resolvePageWindowsWith`), else the focused app
  window. Context menus are native Electron menus; background instances log them to `activation.log` instead.
- **Launch links.** URLs and files on the command line wait for the first window; a second launch with the same data
  folder hands its links to the running app (`second-instance`), or opens a window (`--new-window`) or reopens one.
- **Default browser and login.** `xdg-settings set default-web-browser ardia.desktop` (an AppImage first writes
  `~/.local/share/applications/ardia.desktop` and its icons); open at login is `~/.config/autostart/ardia.desktop`.
- **Updates** come from the GitHub releases of the repository the build was made from (`ARDIA_UPDATE_REPOSITORY` at
  build time): Ardia checks every 6 hours and offers the release page; it doesn't update itself yet.
- **Secrets** (`ArdiaKeychain`) are sealed with `safeStorage` (the desktop keyring through libsecret or KWallet; with
  no keyring Electron falls back to its `basic_text` key).

## Chrome services

`apps/browser/linux/src/services` answers the Mac engine's data domains in TypeScript, in the main process.

- **Storage.** One SQLite database per profile (`node:sqlite`), `<data>/Profiles/<id or Default>/Ardia.sqlite`,
  migrated by `user_version`. Private profiles get an in-memory database and refuse saved-data calls, like the Mac's
  off-the-record profiles. Secrets (passwords, card numbers) are sealed with `safeStorage`.
- **History, favicons** fill from linux-pages' page events (`engine/pages.ts`): main-frame navigations, titles, icon
  URLs. Icons are fetched through the page's session; PNG and JPEG decode in main, anything else (ICO, SVG, WebP) in a
  hidden decoder window that closes when idle.
- **Bookmarks, site settings, zoom, autofill, search suggestions, browsing-data clearing** answer their domains.
  `siteSetting`/`rememberSiteSetting` and `zoomFor` in `services/sites.ts` are the store permission prompts and zoom
  read and write.
- **Page scripts.** `definePageScript` registers a frame preload on every page session (`onPageSession`); the
  password manager (fill, catch submitted logins, `ArdiaLinuxPasswords` `prompt`/`resolvePrompt` keyed by the page's
  webContents id), autofill and the content blocker's cosmetic filtering use it.
- **Autofill** (`services/pageAutofill.ts`) finds address and card fields by `autocomplete`, then by name, id,
  placeholder and label, and shows saved entries in a dropdown under the field when it's clicked, typed in or
  ArrowDowned (a closed shadow root in the page; the values reach the page only when one is chosen). Choosing fills the
  form's empty fields of that kind, selects included; cards only in secure contexts, never the CVC. A submitted form
  with a street and a city or postal code, or a valid card number, gets Chrome's "Save address?", "Update address?"
  (New/Old) or "Save card?" as the page's `autofillPrompt`, answered through `resolveAutofillPrompt`; private windows
  fill but never offer to save. The autofill shortcut and "Manage…" open Settings › Autofill.
- **Requests.** Electron keeps one `webRequest` listener per event per session, so filters go through
  `services/requests.ts` (`onBeforeRequest`, `onHeadersReceived`), never the session directly.
- **Content blocker.** `@ghostery/adblocker`'s engine with uBlock Origin's default lists, cached and serialized under
  `<data>/ContentBlocker`.
- **Extensions.** `session.extensions` plus `electron-chrome-extensions` (chrome.tabs, chrome.action, …) and
  `electron-chrome-web-store` (the Web Store's install button). Their preloads are embedded in the bundle and written
  out at startup as the packaged app's fallback; the libraries are `require`d so their CommonJS builds resolve their
  own preloads in a checkout. `ArdiaLinuxExtensions.executeAction(webContentsId, id)` answers a page's
  `executeExtensionAction`. Site access isn't offered: Electron can't withhold an extension's host permissions or
  content scripts per site, so `siteAccess` is null (the pane hides the row) and narrowing it is refused. They don't
  run in private windows either: Electron loads extensions only into sessions kept on disk, and private windows' are
  in memory, so "Allow in Incognito" is refused and hidden (`PLATFORM_FEATURES.extensionsInPrivate`).
  Web Store extensions update from Google's update service a minute after the profile starts and every 5 hours
  (`ArdiaLinuxExtensions.checkForUpdates(profile)` runs it now): a newer version is downloaded next to the old one,
  loaded in its place, recorded in the registry, and the old folder removed.
- **Sync.** `ArdiaSync` (`services/sync`) is the Mac's and Windows' vault in `node:crypto`, so one sync folder serves all
  three: HKDF-SHA256 keys from the 32-byte recovery entropy, base32 HMAC tags for the chain and scope folders,
  AES-256-GCM `.nns` files padded to 1 KB, synthetic-nonce password seals, the BIP-39 phrase, legacy `pw:` records
  sealed on read and opened on write. The key is sealed with `safeStorage` in `<data>/Sync/sync-key-<device>`. The
  default folder is `Ardia Sync` in the first of `~/Dropbox`, `~/Nextcloud`, `~/OneDrive`, `~/Sync`, … that exists
  (the instance's `syncFolder` in a test instance). The Recovery Kit is the Windows TypeScript (PDF, text, QR code);
  its preview is the same layout as SVG; "Copy" puts the PDF on the clipboard as a file (`text/uri-list`). There's no
  device owner check before showing the words yet (`ARDIA_TEST=reauth=denied` refuses, for tests).
  `node --test apps/browser/linux/src/services/sync/sync.test.ts` opens the Mac and Windows fixture vaults, matches
  their password seals byte for byte and checks what Linux writes with an independent WebCrypto implementation.
- **Import.** `ArdiaImport` runs the Windows readers in main with a Node host: Chrome, Chromium, Brave, Edge, Vivaldi,
  Opera, Firefox and Zen under `~/.config`, `~/.mozilla`, snap and flatpak homes; Chromium's v10/v11 keys (built-in
  key, libsecret or KWallet), Firefox's key4.db.

## Sandbox

Chromium decides before any JavaScript runs, and aborts when the setuid helper is present but not setuid root and user
namespaces are unusable, so the decision is a shell function (`apps/browser/linux/packaging/sandbox.sh`) that the
packaged `ardia` launcher, `pnpm dev` and `scripts/linux/test-instance` run first: unprivileged user namespaces when the
kernel allows them and AppArmor doesn't restrict them (or a profile grants `userns` to the binary), else a setuid-root
`chrome-sandbox`, else `--no-sandbox`. The launcher passes the reason on and `launch.log` records it. The `.deb`'s
postinst always makes `chrome-sandbox` setuid root (electron-builder's own keeps it 0755 whenever
`unshare --user true` succeeds, which it does on Ubuntu 24.04 even though AppArmor then blocks Chromium's namespace
sandbox) and installs an AppArmor profile that grants `userns` to `/opt/Ardia/ardia.bin`. An AppImage can't carry a
setuid helper, so it is sandboxed where user namespaces work and runs with `--no-sandbox` elsewhere.

## Packaging

`pnpm -C apps/browser/linux package [--arch x64|arm64|all] [--target AppImage|deb|dir|all]` stages `out/` and `ui/`
(no source maps) with a `package.json` that has no dependencies, since the main process is one esbuild bundle, and
electron-builder makes `dist/Ardia-<version>-<arch>.AppImage` and `.deb`. The Electron binary ships as `ardia.bin`
behind the `ardia` launcher script; `ardia.desktop` has `StartupWMClass=ardia` (Electron names the windows' class
after the desktop file), the `http`/`https`/`text/html` handlers and a New Window action. The version and build number come from the Mac project (`scripts/version.mjs`), the
icons from its asset catalog, the intro music from the Windows build.

## Paths

Data in `$XDG_DATA_HOME/ardia` (default `~/.local/share/ardia`) or `ARDIA_DATA_DIR`, config in
`$XDG_CONFIG_HOME/ardia`. Test instances always set `ARDIA_DATA_DIR`.

## Running it

- `pnpm -C apps/browser/linux dev`: Vite serves the UI, Electron loads it.
- `pnpm -C apps/browser/linux build`: the UI bundle and the main process, then `package` makes the AppImage and `.deb`
  in `apps/browser/linux/dist`. Agents building in parallel give their UI bundle its own folder:
  `ARDIA_UI_OUT=<dir> pnpm -C apps/browser/linux build:ui`, then run with `ARDIA_UI_DIR=<dir>`, so one build never empties
  the `ui/` folder under another's running instance.
- Headless: `scripts/linux/xvfb <display> -- <command>` runs a command on a virtual display (the system Xvfb, or one
  unpacked in `~/.local/xvfb`).
- `scripts/linux/test-instance <name> [--port N] [--display N] [--data DIR] [--app PATH] [-- <links>]` builds nothing,
  starts a hidden instance on its own Xvfb with its own `ARDIA_DATA_DIR` and debugging port, waits for the port and
  prints the pid; `--stop` quits it through the quit handshake and stops its Xvfb. `--app` runs a packaged build (an
  extracted AppImage folder or `/opt/Ardia`).
- `scripts/linux/capture <port> <out-dir>` screenshots every app window and page over CDP.
- `scripts/linux/launch-smoke <out-dir> [--app PATH]` is CI's check: a fresh instance with a fixture page as a launch
  link, the first window and the loaded page within 90 s, screenshots, a clean quit and a saved session.
- CI (`.github/workflows/linux.yml`) runs on pushes and PRs to `linux`, on x64 and arm64: typecheck, build, package,
  the smoke on the checkout's build and on the extracted AppImage under `xvfb-run`, checks of the `.deb`, and uploads
  the screenshots, logs, AppImage and `.deb`.
