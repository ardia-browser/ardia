# Personal app isolation and local signing

- Status: active; migrated-profile behavior manually validated. Lifecycle failure paths use disposable-profile tests.
- Source: [fork PR #5](https://github.com/simon-ami/ardia/pull/5),
  [PR #6](https://github.com/simon-ami/ardia/pull/6).
- Behavior: deliver a standalone Release at `~/Applications/Ardia Personal.app`, bundle ID
  `dev.simon.ardia.personal`, with separate profile/configuration and `ardia-personal` runtime/credential service.
  Keep the official app and CLI unchanged. Disable the upstream updater/CLI installer.
  Skill commands, references, and tool permissions use `ardia-personal`; preserve this during merges and refreshes.
- Reuse Simon's signing identity. Permit shared `Ardia Safe Storage` only after validating the personal
  signature and sealed files. Keep mock storage for scratch/ad hoc builds and real-profile debugging restrictions.
- Register HTTP/HTTPS without changing the chosen default. Reject stale builds; activate paired app/CLI versions.
  Snapshot the stopped personal profile/preferences first. Failed backup blocks installation; failed activation
  restores the previous app/CLI. Share userscript sources, not installed copies or live Chromium folders.
- Code/checks: `scripts/personal/` (path/lifecycle/signing tests), `ArdiaPersonalSigning.h`, `ArdiaLaunchConfig.mm`,
  `ArdiaHost+Launch.mm`, `CliInstaller.swift`, and CLI `browse/vault.py`.
- Manual when affected: existing login survives restart; profiles/settings, Bitwarden, scripts, and CLI routing work.
- Details only when needed: [setup, snapshots, and recovery](../personal-app.md).

- Replacement: `v0.2.47-nightly.9` moves the official CLI to a plugin with shared PATH links.
  The personal bundle refuses plugin program links and offers its own control toggle in Advanced.
  Prepare the pinned upstream CLI with personal profile, Keychain, state, helper paths, and skill commands.
