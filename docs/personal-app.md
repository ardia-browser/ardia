# Personal app setup

## Current state

Release builds and starts without Metro. The personal build wrapper creates a separate signed app with
bundle ID `dev.simon.ardia.personal`. Its updater feed is removed. It registers HTTP and HTTPS support;
it does not register file or document handlers. The app is installed at `~/Applications/Ardia Personal.app`.
The personal build supports the shared `Ardia Safe Storage` keychain item.
Its signing and storage checks are described below. Simon reported the fresh-profile login test passed:
the website remained signed in after quitting and reopening the personal app. Data has since been copied;
Simon reports tabs, settings, spaces/profiles, existing logins, Bitwarden, and scripts work in spot checks.

The personal app uses `~/Library/Application Support/dev.simon.ardia.personal` for its own data.
Its Chromium profiles are in `Chromium`; its editable configuration is in `config`.
The official app keeps its own data and `~/.config/ardia` configuration. At migration, the official configuration
folder did not exist. Its profile and selected window and appearance preferences were copied.

## Build and sign

Run `python3 scripts/personal/build-app.py`. It uses the matching prebuilt engine, calls the existing locked
build wrapper when app inputs changed, prepares the paired CLI, and signs the app copy.
`--sign-only` requires a recorded Release whose sources, engine, executable, JavaScript, and bundle metadata
still match. Older unrecorded builds need one normal build. The output is
`apps/browser/build-personal-signed/Ardia Personal.app`.

For an approved daily-use update, add `--install`. It verifies the signed app, copies it to
`~/Applications/Ardia Personal.app`, and registers HTTP and HTTPS support. It does not select a default browser.
Prefer building and testing first, then running the installer without rebuilding.
Quit the personal app first. The installer refuses to replace a running app or an unrelated bundle.
It keeps the previous installed app at
`~/Library/Application Support/Ardia Personal/Installed Builds/Ardia Personal.previous.app`.
It removes this checkout's build copies from the browser-handler registry and registers the installed app.
`python3 scripts/personal/install-app.py` installs an already signed build without rebuilding or unlocking the key.
Build and installed copies use the same personal profile; they must not run at the same time.

## Build records and update backups

`python3 scripts/personal/status.py` reports whether installed and candidate source records match this checkout.
It does not validate signatures or claim that tests passed. The signed `Contents/Resources/personal-build.json`
records app input hashes, Git commit and dirty state, engine source tree and binary hash, certificate fingerprint,
and the paired CLI runtime. Committing unchanged inputs or editing documentation does not require a rebuild.
The unsigned-build record also checks the executable, bundled JavaScript, Info.plist, and embedded engine bytes.
Missing records or mismatches do not silently pass `--sign-only` or installation.

Before replacement, the installer creates a private snapshot in
`~/Library/Application Support/Ardia Personal/Updates/<timestamp-id>` containing:

- `profile`: the personal profile, including installed scripts and editable configuration, when present.
- `preferences.plist`: exported personal macOS preferences.
- `app`: the previously installed app, when present.
- `update.json`: the candidate build and previous CLI reference; state is `prepared`, `installed`, or `failed`.

The APFS copy is independent. The installer compares file layouts and sizes, checks that source timestamps
stay unchanged, and rechecks the profile before replacement. It does not hash every profile file on every update.
A socket or special file, a changed profile, or a failed copy stops installation. `INCOMPLETE` marks a failed
profile snapshot; do not restore from it. The original migration backup remains separate and unchanged.

App and CLI activation is coordinated. If replacement or registration fails, the installer restores the previous
app and CLI reference. It does not restore profile data automatically after a later app failure. On request,
preserve the failed current state and restore the matching app, profile, preferences, and CLI reference from
one complete snapshot. A profile-format upgrade may make an app-only downgrade unsafe.
Keep snapshots private and out of Git; do not delete them automatically. They do not back up the shared
Safe Storage key or the signing identity.

The dedicated signing keychain is `~/Library/Application Support/Ardia Personal/Signing/signing.keychain-db`.
If locked, obtain its password through the private secret tool and pass the returned file with `--password-file`.
Never put the password in arguments, logs, Git, or a persistent script. The wrapper locks the keychain after signing.
This unlocks only the signing identity; it does not unlock website passwords or cookies.

The encrypted `.p12` backup and its Base64 text are in the same Signing folder. Simon saved the Base64 text
in a Bitwarden Secure Note and the export password in a separate linked login item. Backup restoration and
signing a changed test binary with the same identity were verified. Do not regenerate the identity for normal builds.

## Shared sources and separate copies

| Item | Handling |
| --- | --- |
| App source | One Git checkout feeds the builds. |
| Built apps | Release, signed build, and installed app are separate program files. Signing and installation do not copy browser data. The two personal app copies use the same personal profile. |
| Signing identity | Reuse one identity for personal builds. The official app keeps its upstream signature. |
| Cookie encryption key | Both apps use `Ardia Safe Storage` in the macOS keychain. This shares a key, not cookies or profiles. |
| Browser profiles | The official profile was copied into the personal folder. They are independent. Never run both apps against one live profile folder. |
| Userscript source | All four original source files already reside in `~/Documents/Work/Personal Projects/userscripts`. Both CLIs can use those same files. No source was moved or duplicated. |
| Installed userscripts | Each profile needs its own installation. Apply source changes to both profiles when desired. |
| Script and extension data | Treat stored values and extension settings as profile-specific. Do not assume they sync with script source. |
| CLI | `ardia` keeps the official runtime. `ardia-personal` uses a separate runtime and the personal data folder. |

Before changing a location, explain the source, destination, and whether later changes propagate.
Retain the official installation and original profile until migration and rollback have been tested.

## Shared Safe Storage

Simon chose the existing `Ardia Safe Storage` item on 2026-11-06. No Chromium rebuild is needed.
The signed personal bundle records the certificate fingerprint and this storage choice. Before using a real
profile, the app checks its running code against that certificate and the personal signing identifier.
It also checks the app's sealed files on disk.
Missing or invalid personal signing configuration stops startup. Scratch profiles keep the mock keychain.
Ordinary ad hoc builds also keep the mock keychain. The real-profile debugging restrictions remain active.

The first real start can show a macOS request to use `Ardia Safe Storage`. Simon must approve it himself;
the setup does not change the existing item's access list. The macOS dialog can request the Mac login password,
not the signing-backup password. Choose Always Allow only for this personal app when offered.
Cancel and report any different request.

The official app does not need to stay installed for this key to work. Keep the keychain item when removing it.
Deleting the shared key can make saved cookies and browser passwords unreadable in both profiles.
Bitwarden remains independent. The Bitwarden signing backup restores the app-signing identity; it does not
back up this separate cookie-encryption key.

Before copying real data, manually start the personal Release app with a fresh personal profile. Confirm any
expected Safe Storage prompt. Test a disposable website login, quit, reopen, and confirm that it remains signed in.
Do not copy the official profile for this test. Simon confirmed this test passed on 2026-11-06.

## Personal CLI

The app build runs `prepare-cli.py --prepare-only`. It verifies the pinned macOS Command Line plugin
archive and prepares an isolated CLI runtime in `apps/browser/build-personal-cli`. Preparation
leaves `current` in place. The Personal signing step removes the legacy CLI installer from the app bundle. The app installer activates the runtime recorded in the signed candidate.
The runtime uses the personal profile, Keychain service, and CLI state. Its managed helper uses
personal installation paths. Old runtimes remain available for rollback.

For a deliberately separate CLI update, `prepare-cli.py` activates its prepared runtime; `--install` also adds
`~/.local/bin/ardia-personal`. It does not change `ardia` or the shell configuration.
Keep this checkout at its current location while using that symlink.
Simon's global `~/.codex/AGENTS.md` directs browser automation to use `ardia-personal` wherever the Ardia skill
says `ardia`. The prepared skill and references also use `ardia-personal` for CLI invocations and tool permissions.
Keep skill name `ardia`, paths, environment variables, and literal app labels unchanged. Preserve these
substitutions during upstream merges and installed skill refreshes; see [the workflow](personal-workflow.md#installed-agent-skills).
Use the official command only on an explicit request.

`ardia-personal` always selects the personal data folder. It clears inherited remote-browser endpoints and
refuses endpoint overrides. CLI credential items use the separate service
`dev.simon.ardia.personal.browse.auth`. This does not copy credentials or change Bitwarden.
The personal app cannot run or update the official CLI installer. Personal background hooks are not configured;
`hooks install` and `hooks uninstall` refuse this explicit data folder.

For future userscript changes, keep one source file outside both profiles. Install that source separately with
each CLI when both browsers need it. Source edits alone do not update either installed copy.
The four installed scripts were copied with the profile. The personal build replaces the copied extension
reference to the official Scripts folder with its own installation. A disabled installation stays disabled.
Unrelated extensions and the official profile remain unchanged. Migration omits `Scripts/status.json` so the
personal build checks and loads the copied scripts at first start.

## Migration record

On 2026-11-06, both browsers were stopped. The official and personal app versions were 0.2.44; both session
schemas were 9. Cloud sync was disabled. No linked shared folders were found.

- Source: `~/Library/Application Support/com.ardia.browser`.
- Destination: `~/Library/Application Support/dev.simon.ardia.personal`.
- Backup: `~/Library/Application Support/Ardia Personal/Backups/20261106-134043`.
  `official-profile` holds the original snapshot; `personal-before` holds the personal test profile.
  The directory also holds both preference exports and a migration record. Keep it private and out of Git.
- Verified 7,076 copied files by SHA-256. The original profile remained byte-identical during the copy.
- Omitted old lock files, legacy migration markers, script load status, and the pending telemetry queue.
  Copied appearance and window preferences; retained the personal updater preferences.
- The four script source files remain shared at their existing location. Installed scripts, extension settings,
  cookies, history, and tabs are separate copies from this point forward. Later edits do not propagate.
- Manual validation: Simon reports tabs, settings, spaces/profiles, existing logins, Bitwarden, and scripts
  work in spot checks. Script execution counts were not measured separately. The extension path cleanup
  also passed 25 nearby automated checks, typecheck, a Release build, and a hidden launch.

For rollback, stop both apps first. Preserve the current personal folder separately, restore `personal-before`
to the destination, and import `personal-defaults.plist` into `dev.simon.ardia.personal`. Never overwrite the
official profile as part of rollback.

## Verification completed

- Release build, signature verification including nested code, and hidden launch with no Metro.
- Personal bundle ID, disabled updater, HTTP/HTTPS registration, and absent file/document registrations.
- Installed app starts hidden with scratch data. Installation refuses a running app and an unrelated bundle.
  Reinstallation preserves the previous app. Launch Services lists the installed app for HTTPS; the default
  HTTP/HTTPS browser choice remained unchanged during installation.
- Lifecycle tests verify independent profile snapshots, stale-source and modified-build rejection, coordinated
  app/CLI rollback, failure before replacement when backup fails, and profile-change detection before activation.
  External signing and registry operations are simulated in these tests. A real Release candidate also passed
  signature verification and a hidden scratch launch. Repeated preparation reused the app and CLI archive;
  the installed app, active CLI, and real profile were left unchanged during this lifecycle verification.
- Locked-keychain and wrong-password failures without interactive prompts.
- Refusal to replace a running personal app.
- Scratch instance loads one window; updater is unconfigured and installed CLI version is absent.
- Native path tests verify separate default configuration paths and scratch overrides.
- With a temporary home and no scratch override, the personal app loads its own session; `ardia-personal`
  reaches that window. No actual user profile is read.
- The running personal app refuses the official CLI installer. The original `ardia` symlink stays unchanged.
- Personal CLI endpoint tests, 142 existing CLI tests, and affected TypeScript checks pass.
- Shared-storage change: 1,643 browser tests, 13 project-script tests, and affected TypeScript checks pass.
- The final Release app starts hidden with scratch data and reports `--use-mock-keychain` on its version page.
  An ad hoc copy refuses real-mode startup before creating its Chromium profile folder.
- A signed fixture creates an item in a disposable keychain. A rebuilt fixture with the same certificate
  reads it without a prompt. Invalid certificate pins, another identifier, ad hoc signatures, and changed
  sealed resources are rejected before keychain access. Run with
  `python3 scripts/personal/tests/signing-test.py --password-file <private-file>` after building the personal app.

Manual tests confirm fresh-profile login persistence and basic migrated-profile behavior, including existing
logins and Bitwarden. Extended daily use remains unverified. The disposable keychain is removed after the test.
