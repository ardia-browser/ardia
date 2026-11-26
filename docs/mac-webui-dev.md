# Mac WebUI shell (dev only)

The Mac app can run the shared WebUI (`apps/desktop --mode mac`) as its shell, the way Linux and Windows do, so it
can be tried on a Mac with Liquid Glass. It exists only in Debug builds: Release compiles the flag out, and no release
script builds or ships the bundle (`packages/shell/scripts/webUIShellHost.test.mjs` checks both).

## Running it

First build the WebUI host, the Chromium `.app` that serves the bundle. It is dev-only and lives in
`scripts/mac/webui-engine/`, not `engine/`, so the Mac Release engine key never changes. Build and assemble it with the
scripts in that folder. Then either put the `.app` beside the Debug app as `Ardia WebUI Dev.app`, with bundle identifier
`com.ardia.browser.webui-dev`, or pass its path with `--webui-app`. With no host the Debug app logs why and stays on
React Native.

```sh
scripts/mac/run-webui-dev.sh                       # build the bundle, open the newest Debug app as the WebUI shell
scripts/mac/run-webui-dev.sh --background --port 9333 --data-dir /tmp/webui-scratch
scripts/mac/run-webui-dev.sh --webui-app /path/to/Ardia\ WebUI.app
scripts/mac/run-webui-dev.sh --help
```

Or by hand, on a Debug app: `ARDIA_SHELL=webui` or `--ardia-shell=webui`.

- Without `ARDIA_DATA_DIR` the profile is `~/Library/Application Support/Ardia WebUI Dev`, never the live one. A data
  dir inside the installed app's profile (`Application Support/com.ardia.browser` or `Application Support/Ardia`, by any
  case, symlink, `..` or alias) is refused: the script stops before it makes anything, and the app logs
  `[webui-dev] refusing to start` and exits (status 78) before isolation, migration or the engine touch it. To try a
  real profile, copy it and pass the copy. The WebUI writes `session.json` back in its own format, which the React
  Native app can't read, so a copy is one-way.
- The app hands off to the WebUI host: `ARDIA_WEBUI_APP`, else `Ardia WebUI Dev.app` beside the running app, whose
  `CFBundleIdentifier` must be `com.ardia.browser.webui-dev`. A host's executable must resolve, through any symlink, to a
  regular executable inside its own `Contents/MacOS`. With no usable host it logs `[webui-dev] no usable WebUI host at …`
  and stays on the React Native shell.
- `scripts/release/archive.sh` runs `scripts/release/no-debug-build.sh` before it archives: it refuses
  `RELEASE_BUILD_SETTINGS` that define `DEBUG` or name the WebUI shell. It also reads the app's and the pods' effective
  Release settings with the archive's own architecture, signing xcconfig and extra settings: the app with the archive's
  destination, the pods with `-sdk macosx`. Each dump is checked on its own. It fails if xcodebuild couldn't read a
  target or dropped the destination, if a target lists no settings or isn't a macOS Release build, if a required target
  is missing, or if any target defines `DEBUG`.

## Pieces

| Where | What |
| --- | --- |
| `packages/ardiacore/ios/ArdiaLaunchConfig.mm` | Reads `ARDIA_SHELL`, `--ardia-shell=webui`, `ARDIA_WEBUI_APP` and `ARDIA_WEBUI_HANDED_OFF` under `#if DEBUG`, and sets the isolated data dir before `ArdiaIsolation`'s `+load` reads it. `webUIShell`, `webUIDataDirectoryDefaulted`, `webUIHostApp`, `webUIHandedOff`. Tested in both builds by `tests/launch-config-webui.test.mm`. |
| `packages/shell/ios/WebUIShellHost.swift` | Picks and checks the host and `execv`s it with `ARDIA_DATA_DIR`, `ARDIA_SHELL=webui`, `ARDIA_WEBUI_HANDED_OFF=1` and `--ardia-shell=webui`. |
| `apps/browser/macos/Ardia-macOS/main.swift` | Calls `WebUIShellLaunch.routeIfRequested(config)` before migration and the engine start. |
| `apps/desktop` | `--mode mac`: `build:mac` (into `dist/mac`), `dev:mac`, `tsconfig.mac.json`, the `.mac.ts` seams, `test:graph` and `test:host` for mac. |
| `apps/desktop/src/platform/windowGlass.mac.ts` | Vibrancy backdrops ask the host for glass behind the window. |

## What the WebUI host provides

The host (`scripts/mac/webui-engine`) is the Chromium `.app` that serves the bundle:

- It loads the bundle from `ARDIA_WEBUI_BUNDLE` (`run-webui-dev.sh` sets it to `apps/desktop/dist/mac`).
- It starts with `ARDIA_WEBUI_HANDED_OFF=1`, `ARDIA_SHELL=webui`, `ARDIA_DATA_DIR` and `--ardia-shell=webui`. A Mac
  app started with `ARDIA_WEBUI_HANDED_OFF` set stays on React Native, so a host that hands back can't loop.
- `shell.backdropRegions`: the page sends `{ regions: [{ rect: { x, y, width, height }, material: "liquid" | "sidebar"
  | "underWindow" }] }` in CSS pixels whenever a vibrancy backdrop moves. The host puts glass behind the window there
  and advertises the method in `bootstrap.capabilities`. Without it, backdrops draw the CSS vibrancy as on Linux.
- Glass over pages uses the existing `shell.glassRegions` contract (`apps/desktop/src/glassRegions.ts`), with an
  under-glass slot per page as on Linux.
