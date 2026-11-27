# CI runners

[Blacksmith](https://www.blacksmith.sh) runs our CI. Its GitHub app (`blacksmith-sh`) is installed on `ardia-browser`,
so a job picks a Blacksmith machine by its `runs-on` label alone. Its Ubuntu images mirror GitHub's, so the Android SDK,
Chromium, Rust and the rest of GitHub's toolchain are already there, and `actions/cache` and `setup-node`'s cache use
Blacksmith's cache without any change to the steps.

| Label | Machine | Used for |
| - | - | - |
| `blacksmith-2vcpu-ubuntu-2404` | 2 vCPU, 8 GB | gates, bots, `which checks run`, vouch, CLA, stale, linked-issue, caches, preflights |
| `blacksmith-4vcpu-ubuntu-2404` | 4 vCPU, 16 GB | the `browser tests` shares, `repository, vouch and stale tests`, site and service deploys, the Linux update helper, the Windows JavaScript bundle and source checks |
| `blacksmith-8vcpu-ubuntu-2404` | 8 vCPU, 32 GB | `typecheck, tests and Mac bundle`, Linux `checks` and `package`, the Android app, `core-rs (ubuntu-latest)`, the Linux release build |
| `blacksmith-6vcpu-macos-27` | M4, 6 vCPU, 24 GB | Swift tests, iPhone packages, release checks and signing |
| `blacksmith-12vcpu-macos-27` | M4, 12 vCPU, 48 GB | the Mac app, the iPhone app, the Mac release build, the iPhone release |
| `blacksmith-6vcpu-macos-15` | M4, 6 vCPU, 24 GB | the release's `publish` job |
| `blacksmith-6vcpu-macos-latest` | M4, 6 vCPU, 24 GB | `core-rs (macos-latest)` |

macOS 27 ships Xcode 27; the Mac and iPhone workflows pin Xcode 27.1 with `DEVELOPER_DIR`.

## Caches that make it fast

- Turborepo's remote cache is on for the org (Blacksmith Settings › Caching), so `pnpm typecheck` and the turbo test
  tasks replay unchanged packages; a job log says `Remote caching enabled` and `cache hit, replaying logs`.
- The Android job runs Gradle with `--build-cache`. Pushes to `main` save `~/.gradle` under the build files' hash plus
  the commit, and pull requests restore the newest one, so unchanged modules and their unit tests come from the cache.
- `core-rs` keeps its Cargo registry and `target` in the Actions cache, keyed by the toolchain and lockfiles.

## What stays on GitHub

The Windows jobs (`windows.yml` and `core-rs (windows-latest)`) stay on `windows-latest` and `windows-11-arm`.
Blacksmith's Windows Server 2025 runners are a public beta with Visual Studio Build Tools instead of the Visual Studio
install the React Native Windows build finds with `vswhere`, and Blacksmith has no Windows on ARM.

## The check

`scripts/ci/runners.test.mjs` (run by `node --run test:root`) fails when a workflow uses a label that is neither a
Blacksmith label nor one of the two GitHub Windows labels, so a new job can't drift back to GitHub's Linux or macOS
runners.

## Cost

Blacksmith bills by the minute at half GitHub's rate, and its free tier is 3,000 2-vCPU Linux minutes a month. Larger
machines use minutes in proportion to their vCPUs; one 6-vCPU macOS minute counts as 20. Usage is on the Blacksmith
dashboard (app.blacksmith.sh).
