# Ardia on Linux

Ardia on Linux runs the Mac's and Windows' TypeScript UI (`apps/browser/src`, `packages/*/src`) on Ardia's own engine:
Chromium 157.0.8103.50 with Helium 0.21.2 (helium-linux 0.21.2.1) and our patch series, the engine the Mac and Windows
builds use, with `//ardia/linux` linked into Chrome's own `chrome` binary. There is no Electron and no Node at run time:
the UI is a web bundle Chrome loads as a WebUI (`chrome://ardia-app/`), and pages are real Chrome tabs drawn under it.
`docs/linux-engine.md` is the design: the process, the UI host and its bridge, windows, pages and input, focus and
keys, menus and dialogs, every module's home, launching, the sandbox, packaging and test instances. Building the
engine is `docs/engine-build-linux.md`. Platform files are named `*.linux.ts(x)` beside the shared ones, as `*.windows`
are for Windows (`docs/windows.md`), and the shared platform layer (`lib/platformFeatures`, `lib/platformChrome`,
`lib/platformTerms`, `platform/windowControls`, the app-drawn window buttons) serves both.

The first Linux port ran the same UI in Electron (pages as `<webview>` elements, Chrome's services rewritten in
TypeScript). It was removed once the engine build walked its 64 rows at least as well; its design, its walk and its
code are in git history (`docs/linux.md` and `apps/browser/linux/src` before commit 9a140faac).

| Where | What |
| --- | --- |
| `scripts/linux/engine/src/ardia/linux` | `//ardia/linux`, our code in Chrome's browser and renderer processes: the UI host and its Mojo bridge, app windows, `Host` (tabs, input region, keys), the viewless `BrowserWindow`, the native modules, Chrome's prompts handed to the app, the page channel, the content blocker |
| `scripts/linux/engine` | The engine tree in `~/chromium-build-linux`: sync, GN args, Helium, the series (`series-linux`, `series_linux.py`), builds, the engine tarball (`06-package.sh`) and the published prebuilt (`prebuilt.json`) |
| `packages/expo-linux` | `expo-modules-core` and React Native on react-native-web in the UI's renderer (`bridge.ts`, `modules.ts`, `host/`, `windows/`, `views/`, `web/`, `reactNative/`), and in `src/chromium` the engine backend: the four modules swapped into `expo-windows/src/engine`, the domain tables' Linux answers, the key map, the import readers, sync's Recovery Kit, translate's worker, the updater, the recorder |
| `apps/browser/linux` | The UI bundle (`renderer/`, one Vite config), its tests and typecheck, `dev`, and packaging (`packaging/`: the sandbox decision, the launcher, the `.deb`'s postinst, the AppArmor profile) |
| `scripts/linux` | `package-engine.mjs`, `fetch-engine.sh`, `test-instance`, `engine-smoke`, `capture`, `xinput`, `xvfb`, `ubo.sh` |
| `.github/workflows/linux.yml` | CI |

## What works on Linux

The 64 rows, walked on the engine build on 2026-11-15: Ubuntu 24.04 (x86_64), a private 1600 by 1000 Xvfb, a fresh data
folder, real X key presses, clicks and drags (`scripts/linux/xinput`), a screenshot looked at for every row. Most rows ran
under xfwm4 with its compositor; first launch with a link, Peek, pop-up menus, focus after a window closes, the first
click into a page and the drops ran again with no window manager. The walk started on commit afc159fd7; the rows it found
broken were fixed on the way and seen working again after the fix (through ccef10bdd), and those rows name the fix. The
packaged build (`pnpm -C apps/browser/linux package` over a fresh `06-package.sh` tarball) was walked from the extracted
AppImage and the `.deb`'s extracted `/opt/Ardia`. Of the 64 rows, 62 work, 2 work with a difference (Chrome's print
preview and JavaScript dialogs) and none is broken. Pop-up windows, links no app handles, the page menus' Cast item and
Report a Problem's recording were walked again after their fixes (through 7f747b65c); the Import screen's images and a
pop-up's password prompt after theirs (6d6358cd5, 96645bb36). The Mac's list is `docs/dia-feature-parity.md`.

**Install, first launch, updates**

| Feature | State | Fixed in |
| --- | --- | --- |
| AppImage and .deb | Works: both packages, run from the extracted AppImage and the `.deb`'s `/opt/Ardia` (unsandboxed here: AppArmor blocks user namespaces and nothing was installed setuid), start at onboarding; a second launch with a link reaches the running instance ("Opening in existing browser session") and opens it in Little Ardia; Ctrl+Q exits in about 200 ms and a relaunch restores the tabs. On the test's private D-Bus, which has no secret service, the packaged launcher (no `--password-store=basic`) waits about 25 s for the keyring before the restored pages finish loading | |
| First launch | Works: onboarding, no release notes | |
| First launch with a link | Works: the meadow plays and the link opens in Little Ardia in front of it; closing Little Ardia leaves onboarding | |
| Onboarding (source, look, last choices) | Works: six steps for Coming from Chrome (colour, frame, sharing, layout, default browser and login, welcome), eight from Starting fresh | |
| Intro animation and music | Works: the meadow scene plays behind the first window (WebGL2 is blocklisted on Xvfb; the scene drew). The music wasn't checked (no audio device) | |
| Tour | Works: three stops for tabs across the top, Back, Next, Done | |
| Import from another browser | Works with a Chromium profile made for the walk (`ARDIA_INSTANCE importSourceDir`): Chromium found, 2 bookmarks and 2 history items imported. Onboarding's "Found on this computer" and the Import window show the browser's own icon and the profile's picture. Before, the test's import folder never arrived, so the dialog searched the real home; and those images were blank (the UI drew them from `file://`, which a WebUI can't load, and the engine looked for no icons) | 7db906421, 6d6358cd5 |
| Check for updates | Works: "Ardia is up to date" with the version and the releases page. Before, "Failed to fetch": Chrome gives a WebUI with bindings no network unless the embedder allows its origin | df5e05602 |
| Default browser | Works: the pane then says Ardia is the default; a test instance writes `ardia.desktop` and `mimeapps.list` under `<data>/Desktop` | |
| Open at login | Works: the autostart entry is written (under `<data>/Desktop` in a test instance) | |

**Windows and tabs**

| Feature | State | Fixed in |
| --- | --- | --- |
| New tab, close, reopen closed tab (Ctrl+Shift+T) | Works | |
| New window | Works | |
| Private window | Works; closing one with two tabs asks (Close 2 tabs?, Don't ask me again) from its close button and from Ctrl+Shift+W. Before, Ctrl+Shift+W closed it without asking | 8a4ba355b |
| Quit and relaunch with the session restored | Works: Ctrl+Q exits in 200 to 300 ms; the window, its place, the split, the group, the Top App and every tab came back. Before, a restored or switched-to tab could show a blank white page: a hidden tab's page slot painted its unpainted fill over the shown one | 6faa98da7 |
| Little Ardia (Ctrl+Alt+N) | Works: recent pages, a page loads in it, Ctrl+W closes it; with no compositor its corners are cut, not black | |
| Search Tabs (Ctrl+Shift+A), Ctrl+Tab | Works: the switcher shows page pictures. Before, every card showed a globe: the engine had no `capturePage` | 5aa48a602 |
| Tabs in the sidebar or across the top (Ctrl+Shift+S), hide the sidebar (Ctrl+S) | Works | |
| Split View (Ctrl+\) | Works: the empty pane offers open tabs; both panes render and take typing | |
| Peek | Works: the Dia preset's Shift-click and the Chrome preset's Alt-click open it with no window manager; Escape closes it and puts focus back on the link. Under xfwm4 Alt-click is the window manager's own move (its easy-click key), so the page never sees it | |
| Pop-up windows from pages | Works: `window.open` with a size opens Ardia's pop-up window (the system frame with the page's title, the origin strip with the connection glyph, the origin and Open as Tab), sized from the page's features and placed under the opener's window top. A sign-in pop-up keeps `window.opener`: Continue posted back to the opener and the pop-up closed itself. Ctrl+W closes only the pop-up; Open as Tab moves the same live page into the opener's window as a tab. Before, it opened as a tab | 15e8bfbd7 |
| Pop-up blocking | Works: `window.open`, a `target=_blank` link and a form opened without a click are all blocked with the prompt (Always Deny, Only Once, Always Allow, the three addresses); with a click they open | |
| Closing a window with unsaved work in a page | Works: its close button and Ctrl+Shift+W ask once for the window ("Leave 127.0.0.1:8737?", Close Window, Cancel); Cancel keeps it, Close Window closes it, and closing the last window quits. Before, it closed without asking | 32c92fb55 |
| Main, Settings and Little Ardia window chrome | Works, app-drawn buttons, no system title bar | |
| Maximize and restore | Works under xfwm4, square corners while maximized | |
| Moving a window, edge snapping | Works under xfwm4: the sidebar header moves the window, a double click maximizes, and dragging a maximized window restores and moves it; the top edge resizes | |
| Pop-up menus (the … menu, tab menus) | Works under xfwm4 and with no window manager. Before, with no window manager, after a window closed every menu (the … menu, tab menus, the page's) never showed: X focus was on the root while Chrome still counted the window active | 1dbffa721 |
| Keyboard focus after a dialog or window closes | Works with no window manager: after Settings closes, the page's field keeps typing | |
| Pin, Top Apps, groups | Works: the tab menu's Move to Top Apps makes a tile; New Group with Tab makes a group and names it in place | |
| Profiles: create, switch with Alt+1, Alt+2 | Works: Create Profile, then Alt+2 and Alt+1 switch; "Work" shows in full. Before, with two profiles, clicks in a 172 by 34 area at the page's top left went to the UI: the other profile's sidebar page reported its selected row as a cover the sidebar's clip never cut | 0f9c79d82 |

**Pages**

| Feature | State | Fixed in |
| --- | --- | --- |
| Command bar (history, open tabs, suggestions) | Works: addresses, Google suggestions | |
| First click into a page that never had focus | Works with no window manager: a restored page, a fresh tab and one reached by a tab click take the click and the keys typed right after it | |
| Find in page | Works: the app's find bar with the match count | |
| Zoom (Ctrl+=, Ctrl+0) | Works, with the zoom popover and the icon in the address bar | |
| Print | Differs: Ctrl+P opens Chrome's print preview over the page (Save as PDF here, with no printers) instead of the system print dialog; Save asks where with the save dialog and writes the PDF | |
| JavaScript alert, confirm and prompt | Differs: all three are Chrome's tab-modal dialogs over the page ("127.0.0.1:8737 says"), prompt included, not the app's prompt | |
| Page, link and image menus | Works: Chrome's menus in the Mac's order. Page: Back, Forward, Reload, Save As, Print, View Page Source, Inspect. Link: Open Link in New Tab, New Window, Split View, Incognito Window, Save Link As, Copy Link Address, Inspect (no Copy Link Text, as on the Mac). Video: Loop, Show Controls, open, save, copy, Picture in Picture. Selection: Copy, Copy Link to Highlight, Search Google, Print. Before, page and video menus offered Cast, which Linux doesn't do | d8dc7070d |
| Full screen (a page element) | Works; Escape leaves it | |
| Picture in Picture | Works: the menu's Picture in Picture opens Dia's window (back to the tab, the origin, ±10 s, play, close); the page shows "Playing in picture-in-picture" | |
| Downloads (download, panel, Ctrl+J) | Works: the panel opens for a new download and lists it. Before, a test instance saved into the real `~/Downloads`: its instance keys reached Chrome under the wrong switch names | 3e47809fc |
| History (Ctrl+H), Clear Browsing Data (Ctrl+Shift+Del) | Works | |
| Bookmarks (Ctrl+D, Ctrl+Shift+O) | Works | |
| mailto and other app links | Works: a `mailto:` link with no usable mail app, and a link to a scheme no app handles, open nothing, as on the Mac; a scheme with an installed handler still asks "Open <app>?". A handler whose desktop entry isn't for this desktop (here an XFCE-only mail helper) counts as none. Before, the desktop portal's "Open With… No Apps available" window appeared | 934577891 |
| Network error page | Works: Chrome's "This site can't be reached" with the error code | |
| DevTools (F12) | Works, docked inside the page's rect | |
| Task Manager (Shift+Esc) | Works: Chrome's Task Manager with every tab's process, memory, CPU and End task | |
| Drop a link or file onto a page | Works: a file dropped on a page that takes drops reaches it; a link dropped elsewhere on a page opens in a new tab next to it | |
| Drop a link onto the tab strip or sidebar | Works: a link dragged from another app onto the sidebar opens as a new tab | |
| Translate | Works: a French page shows the Translate button; the first use downloads the French model, then the page turns to English in place | |

**Passwords, permissions, extensions**

| Feature | State | Fixed in |
| --- | --- | --- |
| Offer to save a password | Works: the app's Save password prompt (Never on This Site, Not Now, Save). Before, the Passwords pane showed Offer to save off on every profile: the engine had no `passwords.autofillEnabled` A password submitted in a pop-up window is offered on its opener's tab while the pop-up stays open, as on the Mac, and Save stores it for the pop-up's address. Before, a pop-up's password got no prompt | aaf7afa62, 96645bb36 |
| Fill a saved password | Works: the form fills when the page loads and the field's dropdown offers the login | |
| Passwords pane: Unlock | Works: Unlock asks for the login password in the app's window; a wrong one says "Wrong password. Try again." (the system's `unix_chkpwd`), the right one unlocks (a stub helper, `ARDIA_TEST passwordHelper`). Before, every check said "Ardia couldn't check the password": Chrome launches children with `no_new_privs`, so the setgid helper couldn't read the shadow file | bce08ce3e |
| Notification prompt and notifications | Works: the app's prompt; the notification shows on the desktop's notification server | |
| Location prompt | Works: the app's prompt; with no GeoClue the page gets "The system location service isn't available" | |
| Camera and microphone | Works with Chromium's fake camera: the app's prompt, then the stream | |
| Chrome Web Store install | Works: Add to Chrome, the app's Add dialog listing the permissions, the extension's toolbar button and its welcome page | |
| Extensions pane | Works: lists the installed extension with its toggle | |
| Ad, tracker and cookie-banner blocking | Works: uBlock Origin blocks the ad and analytics scripts (it hands them its stand-ins, so they report loaded) and counts them; generic hiding stays off on 127.0.0.1, as EasyList says | |
| Bookmark and password export | Works: Export Bookmarks writes a Netscape bookmarks file (mode 0600); Export CSV asks for the login password after the save dialog (Chrome's own export reauth), then writes the CSV with mode 0600. Before, both said "Couldn't export bookmarks: This build has no Windows dialogs" | d4f1bbb20 |

**Settings**

| Feature | State | Fixed in |
| --- | --- | --- |
| Settings window, panes | Works: all panes open; a test instance's save dialogs start in its own downloads folder | ccef10bdd |
| Appearance: light and dark | Works | |
| Keyboard Shortcuts pane | Works, Ctrl keys | |
| Live Folders pane | Works (renders; no service connected) | |
| Sync | Works: Sync folder › Choose…, then Turn On Sync writes the vault and shows Save Your Recovery Kit | |
| Report a Problem: screen recording | Works: the recording pill (Recording 0:03, Stop) floats over the window and isn't recorded; Stop, Escape or the limit end it and the sheet comes back with the recording and its thumbnail; with Include web pages off every page area is black, with it on pages show (an H.264 MP4 at the window's size). Several recordings in a row start. Before, Record said Ardia couldn't record the window | 7f747b65c |

## Sandbox

Chromium's own. Chromium aborts when its setuid helper is present but not setuid root and user namespaces are unusable,
so the decision is a shell function that runs before the binary (`apps/browser/linux/packaging/sandbox.sh`, used by the
packaged `ardia` launcher and by `scripts/linux/test-instance`): unprivileged user namespaces when the kernel allows them
and AppArmor doesn't restrict them (or a profile grants `userns` to the binary), else the setuid-root `chrome-sandbox`
beside it (`CHROME_DEVEL_SANDBOX`), else `--no-sandbox`, with the reason passed on as `--ardia-sandbox-decision` and kept
in `launch.log`. Outside a test instance the engine drops a `--no-sandbox` the launcher didn't decide. The `.deb`'s
postinst makes `chrome-sandbox` setuid root and installs an AppArmor profile granting `userns` to
`/opt/Ardia/ardia.bin`. An AppImage can't carry a setuid helper, so it is sandboxed where user namespaces work and runs
with `--no-sandbox` elsewhere.

## Packaging

`pnpm -C apps/browser/linux package [--engine <tar.xz>] [--arch x64|arm64] [--target deb|AppImage|dir|all] [--out <dir>]`
builds the UI bundle, then `scripts/linux/package-engine.mjs` packs it with an engine tarball (default
`~/ardia-linux/out/ardia-chromium-linux-<arch>.tar.xz` from `scripts/linux/engine/06-package.sh`; the published one comes
from `scripts/linux/fetch-engine.sh <arch> <file>`) into `apps/browser/linux/dist`:

- `/opt/Ardia`: Chromium's runtime files with `chrome` as `ardia.bin`, `chrome-sandbox`, `ui/` (the bundle, no source
  maps), `Extensions/` (uBlock Origin pinned by `scripts/linux/ubo.sh`, its fingerprint and the Lite settings, as the
  Mac bundles them), `ardia.build.json` (version and build from the Mac project, `apps/browser/linux/scripts/version.mjs`),
  `resources/apparmor-profile`, and the `ardia` launcher (the sandbox decision, `CHROME_DESKTOP=ardia.desktop`, then
  `exec -a ardia ardia.bin`).
- `ardia.desktop` (`StartupWMClass=ardia`, the `http`/`https`/`text/html` handlers, a New Window action) and the icons
  from the Mac's asset catalog.
- `Ardia-<version>-engine-amd64.deb` with `dpkg-deb` (postinst, prerm and postrm in the package), and
  `Ardia-<version>-engine-x86_64.AppImage` (`AppRun` is the launcher) on AppImage's static type2 runtime with zstd, so it
  needs no libfuse2; the runtime and `mksquashfs` come from a toolset pinned by checksum and cached in `~/.cache/ardia`.

An engine with the test-build marker (`ardia.test-build`) is refused. Widevine isn't in the package (`docs/linux-engine.md`
› Risks).

## Paths

Data in `$XDG_DATA_HOME/ardia` (default `~/.local/share/ardia`) or `ARDIA_DATA_DIR`, Chromium's profile in
`<data>/Chromium`, config in `$XDG_CONFIG_HOME/ardia`. Test instances always set `ARDIA_DATA_DIR`.

## Running it

- **The engine**: build it in `~/chromium-build-linux` (`docs/engine-build-linux.md`; incremental builds only, under
  `/tmp/ac-chromium-linux.lockf`), or fetch the published tarball with `scripts/linux/fetch-engine.sh x64 <file>`.
- `pnpm -C apps/browser/linux build` builds the UI bundle into `apps/browser/linux/ui`. Agents building in parallel give
  theirs its own folder (`ARDIA_UI_OUT=<dir>`) and run with `--ui <dir>`, so one build never empties the folder under
  another's running instance. A UI change never needs an engine build.
- `pnpm -C apps/browser/linux dev [--engine DIR]` rebuilds the bundle on every change (`vite build --watch` into a scratch
  folder) and reloads a test instance on it under xfwm4.
- `scripts/linux/xvfb <display> -- <command>` runs a command on a private Xvfb and a private D-Bus session bus, so file
  pickers (the desktop portal), notifications and the keyring never reach the logged-in desktop.
- `scripts/linux/test-instance <name> [--port N] [--display N] [--data DIR] [--engine DIR] [--ui DIR] [--app PATH] [--wm]
  [-- <links>]` builds nothing, starts a hidden instance on its own Xvfb with its own `ARDIA_DATA_DIR` and debugging port,
  waits for the port and prints the pid; `--stop` quits it through the quit handshake and stops its Xvfb. `--engine` is
  an out dir (the Linux tree's by default) or an unpacked package, `--ui` the bundle (the package's `ui/`, else
  `apps/browser/linux/ui`); `--app` runs a package as it ships (an extracted AppImage or `/opt/Ardia`). `ARDIA_INSTANCE`
  passes instance keys (`importSourceDir=<home>` points the importer at a fixture home).
- `scripts/linux/engine-smoke [--engine DIR] [--ui DIR] [--out DIR]` is the smoke: a fresh instance under xfwm4 with a
  fixture page as a launch link, then the eight checks of `docs/linux-engine.md` › "The first milestone" with real X
  input (the host loads, the bridge answers, the window shows, the page loads under the UI, the command bar draws over
  it, clicks and the wheel go to the right layer, typing follows focus, Ctrl+Q saves and exits within 3 s).
- `scripts/linux/capture <port> <out-dir>` screenshots every app window (the UI layer) and page over CDP;
  `scripts/linux/xinput <display> shot <file>` takes the composited screen, and `click`, `keys`, `type` and `wheel` are
  real X input.
- `pnpm -C apps/browser/linux test` runs `packages/expo-linux`'s tests with `node --test`; `typecheck` checks the bundle's
  entry and all of `packages/expo-linux` with `.linux` files first; `test:fake` runs the bundle in a headless Chromium
  against the fake bridge. The engine's own tests are `ardia_linux_unittests`, `ardia_linux_modules_unittests`,
  `ardia_linux_import_unittests`, `ardia_linux_sync_unittests` and `ardia_linux_translate_unittests` in the out dir.
- CI (`.github/workflows/linux.yml`, on pushes to `linux` and `linux-dev` and PRs to `linux`, x64): typecheck, the Linux
  and shared UI tests, the prebuilt engine, the bundle, both packages, checks of the `.deb`, and `engine-smoke` on the
  extracted AppImage and on the `.deb`'s `/opt/Ardia`; the screenshots, logs and packages are uploaded.
