# Password managers

Ardia's password manager fills logins from its own store and from credential providers: sources inside Ardia that
talk to another password manager through that vendor's own command-line tool, so Ardia never implements a vault
format, never syncs a vault and never keeps a copy of one. A provider registers into `VaultRegistry`, and none is
built in: 1Password, Bitwarden and Proton Pass come later as official credential-provider plugins (`1password`,
`bitwarden`, `protonpass`, declared through a `contributes.credentialProvider` manifest contribution and running their
CLI through host services), and each vendor's specifics move with its plugin. Ardia's own store (Chrome's password
store for each profile) is a manager too, with the id `ardia`: see [Ardia as a manager](#ardia-as-a-manager).
These managers fill for profiles whose password manager is Ardia (see [Choosing Ardia](#choosing-ardia)).
Addresses and cards (Settings › Profiles › <profile> › Addresses and Cards, and their fill menu) are in
[autofill.md](autofill.md).

## Architecture

```
apps/browser (JS)                       packages/ardiacore/ios (Swift, module ArdiaVaults)
  platform/vaults.ts  ── call("vaults.*") ──>  VaultsModule ──> VaultBroker (actor)
                      ── signIn / unlock ──>                      │  item cache, per-provider lanes,
                      <── vaults.changed ───                      │  state cache, fill and save checks
                      <── vaults.itemsChanged                     v
ArdiaWebView+PageTab ── fillValues / save ──────────────> VaultRegistry.providers
                                                           (empty until plugins register)
                                                                  │  (protocol VaultProvider)
                                                                  v
                                                           VaultCLI ──> VaultCommand ──> Process (the provider's CLI)
```

| File | Role |
| --- | --- |
| `VaultsModule.swift` | The Expo module `ArdiaVaults`: the `vaults.*` call table, the `vaults` event channel, and the two secret-taking functions `signIn(provider, fieldsJSON)` and `unlock(provider, password)`. A typed-password token whose entry is gone (`VaultTypedPassword.expired`) never falls back to Touch ID: unlock answers `needs: password`, "Type your <manager> master password again.", with `entryExpired: true`. |
| `VaultBroker.swift`, `VaultBroker+Lock.swift`, `VaultBroker+SignIn.swift`, `VaultBroker+Items.swift`, `VaultBroker+Fill.swift` | The one actor every caller goes through (its state and provider states; locking and sign out; sign-in and unlock; item lists; fills, copies, codes and saves). Caches provider states and item lists (served at once, refreshed in the background after 60 s), serialises every CLI call per provider through a `VaultLane`, emits `vaults.changed` and `vaults.itemsChanged`, and runs the fill and save checks. |
| `VaultProvider.swift`, `VaultCapabilities.swift` | The protocol a provider implements, plus shared helpers (`makeState`, `signedIn`, `needs`, `failed`, `checked`), and the capabilities it declares. |
| `VaultRegistry.swift` | The list of providers: empty (`static let providers: [any VaultProvider] = []`) until credential-provider plugins register. |
| `VaultCLI.swift`, `VaultCLI+Launch.swift` | One resolved binary plus its environment and its `VaultCLIHost` (the session store in the app, a fake in the Swift tests). Providers only ever run commands through it. The launch file finds the binary and builds the environment. |
| `VaultCommand.swift`, `VaultCommandResult.swift` | The hardened process runner. |
| `VaultBinaryLocator.swift` | Where binaries may live, and the ownership and permission check. |
| `VaultSessionStore.swift`, `VaultKeychain.swift`, `VaultSecretPlace.swift`, `VaultSecretShelf.swift`, `VaultSecretFile.swift`, `VaultOwnerCheck.swift` | Sessions in memory, the optional Touch ID copy, the idle clock, scratch values and preferences per provider, and the running long command (a sign-in that waits on a browser or an app). |
| `VaultAutoLock.swift` | Locks every manager on sleep, screen lock and fast user switch (unless Lock when screen locks is off), checks the idle timeout every minute while something is unlocked, tracks whether the screen is locked, and records the quit for `VaultLockPolicy`. |
| `VaultCache.swift`, `VaultCacheSnapshot.swift`, `VaultSealed.swift`, `VaultStoreKey.swift`, `VaultCloud.swift`, `VaultLedger.swift` | The local sealed store, its file format and key, and the merged iCloud copy. |
| `ArdiaVaultFile.swift`, `ArdiaVaultBackup.swift` | `ardia.vault`: Ardia's codes and the iCloud backup of its logins, and Restore. |
| `ArdiaStandaloneCode.swift` | A verification code saved on its own (label, issuer, website), its id, website check and site match. |
| `VaultArdiaLogins.swift` | New Password and Edit for Ardia logins in Settings: the Chrome store save, update or move, and the code that goes with it. |
| `VaultLockPolicy.swift` | The two lock options, the managers open right now, and the unlocked-at-quit marker. |
| `VaultExport.swift` | Export Passwords: a CSV written natively from the store, after an owner check and the save panel (asked first, so nothing is read before there's somewhere to write). Passwords it has to read from the CLI for the export are used for the file only, never kept in the sealed store or sent to iCloud; a lock during the export stops it. The file is written beside the destination (0600) and renamed into place, so a failure leaves no partial CSV. |
| `VaultOriginMatch.swift` | Pure origin matching (no state, Foundation only). |
| `VaultClipboard.swift`, `VaultPasswordGenerator.swift`, `VaultTotp.swift` | Concealed clipboard copy, strong passwords, one-time code timing. |
| `ArdiaVault.swift`, `ArdiaVaultLogin.swift`, `ArdiaVaultStore.swift`, `ArdiaVaultIndex.swift` | Ardia's own store as a manager: the provider state and item keys, the Chrome store calls (on the main thread), and the actor the broker hands every `ardia` call to. |
| `VaultGenerated.swift`, `ArdiaWebView+VaultGenerated.swift` | Generated passwords that aren't saved in a manager yet: the sealed `Generated.vault`, the fill from it and the save popover's password drafts (their calls are in `VaultsModule`). |
| `VaultPasswordFieldView.swift` | The save popover's password field (`ArdiaVaultPasswordField`), editing a native draft of the captured password. |
| `VaultJSON.swift`, `VaultMessages.swift` | Defensive JSON reading and error text cleanup shared by every provider. |
| `Vault*.swift` value types | `VaultProviderState`, `VaultItem`, `VaultSignInResult` and friends: Codable mirrors of the TS types in `packages/ardiacore/src/vaults.ts`. |

### State

Each manager reports one of `notInstalled`, `signedOut`, `locked`, `unlocked`, `unavailable`. "Unlocked" is Ardia's
own gate on top of the CLI: a manager is unlocked only while the session store holds a session for it. The session is
whatever the provider hands `cli.remember(session:)`: a real session key its CLI printed, or a marker set after its
CLI (or its desktop app) approved a call or after the Mac owner check on unlock.

Lock forgets the session; sign out also tells the CLI to log out. When a CLI reports that the vault is locked or signed
out, the broker drops the session and the cached items and publishes the new state.

### The local store

`VaultCache.swift` is Ardia's own encrypted password store: one AES-GCM sealed file per manager in
`<data dir>/Password Managers/Cache/<id>.vault` (0600 from creation, excluded from backups, written to a temp file,
fsynced and renamed). Each file starts with `ARV2` and an 8-byte id of the key that sealed it (an HMAC of the key); the header and the file's
role and name (`store/<id>`, `marker/deleted`) are authenticated with the contents, so one manager's file can't be
swapped over another's and a file sealed with a key this Mac lacks is told apart from a damaged one (`VaultSealed`).
Files older builds wrote with no name bound (`ARV1`, or a bare AES-GCM box) are accepted only at the store's own main
path and only until that store is bound (`VaultSealedFolder`): the first read opens it, moves it to `<id>.vault.legacy`,
writes the bound copy, reads that back and only then drops the old one and writes `<id>.vault.bound`. From then on, and
in any other file (`.bak`, `.held`, iCloud copies, conflict versions), an unbound blob is refused; one an older build
writes back at the main path after a downgrade is moved aside to `<id>.vault.aside-<n>` on the next write (never read
as the live store, the last 8 kept, deleted with the store) instead of being removed. The previous good
copy is kept as `<id>.vault.bak` and read when the main file is missing or damaged; a file sealed with a key this Mac
doesn't have is moved to `<id>.vault.held`, never overwritten (with one already held, nothing replaces it), and merged
back once the key arrives, the held copy dropped only after the merge reads back. "Couldn't read" is never "missing": a
file that exists but won't read (permissions, I/O, an old-format file no key opens yet) reads as unreadable and is never
written over. A file a newer Ardia wrote (a higher `version`) is read but never written back. It holds the item list and each login's
password and one-time-code secret (whatever the provider's list or read returned). Everything a fill, a copy or a code needs is read from it in memory, so none of them waits for a CLI.

- **One unlock for all of it.** While a file exists, a locked manager's Unlock (and the menu's Unlock row) asks for
  Touch ID or the Mac password once (`VaultOwnerCheck`) and opens every manager's file. The manager then reads as
  `unlocked` even with no CLI session; the CLI sessions come back in the background from a stored session (the Touch ID
  copy) or, for a provider with no master password, a new marker, without a second prompt
  (`VaultOwnerCheck.recentlyConfirmed`, 30 s). A provider with `capabilities.desktopApproval` (its unlock asks the
  person, for example through its desktop app) is never reconnected quietly in the background: it reconnects only when
  something needs its CLI (a code, a save, Sync). A manager unlocked through its CLI (master password, desktop app
  approval) opens the store too.
- **Codes are made on the Mac.** `VaultTotpSecret` reads an `otpauth://` URI, a `steam://` link or a bare base32
  secret (any case, spaces, dashes and trailing padding; SHA-1, SHA-256 or SHA-512 in any spelling such as
  `HmacSHA256`; 6 to 8 digits; a period of 5 to 300 s; Steam's five letters with `encoder=steam` or issuer Steam and
  `digits=5`) and computes the RFC 6238 code. HOTP, other digit counts or periods, and unknown algorithms are refused.
  A URI with raw spaces in its label is escaped before it is kept (`VaultTotpURI`), and a new code needs at least
  80 bits of secret. `packages/ardiacore/tests/vault-totp.test.swift` checks RFC 6238 and RFC 4226 vectors, Steam,
  the period edge and every refusal. The current code is always filled, even in its last seconds: servers accept the
  previous step, not always the next.
  A provider whose list carries no secrets has its first code read the item once (`VaultProvider.revealed`), keeps the
  `otpauth://` URI in the store and makes every later code here. Schemes it can't read still ask the
  CLI; one fetch per item runs at a time, and a code just fetched is reused for a fill while more than 3 s remain.
  The fill menu fetches codes as soon as it opens on a code field, and right after a login with a known code fills.
  The login just filled is pending for its code only on that exact origin and in that tab (not a sibling subdomain,
  since a page there could read the field), and its code row keeps the usual origin check; a split code (one box per
  digit) is typed box by box, focusing each one first.
- **Freshness.** A list older than 60 s is refreshed in the background from the CLI when a session exists, and the file
  rewritten. A cached password or code secret is used only while its item's `updatedAt` is unchanged.
- **Locking.** Lock after, the screen locking and sleep close the store and drop everything in memory (Ardia's own
  codes too, reread from disk on the next use); Lock on one manager hides that manager while the others stay open. Lock
  When Screen Locks (`vaultLockOnScreenLock`, default on) off keeps the store open through sleep, screen lock and fast
  user switch; Lock after still applies. The idle check (once a minute, 15 s tolerance) runs only while a manager is
  unlocked and Lock after isn't Never; nothing ticks while everything is locked.
- **Quitting.** The store always starts closed, unless Lock when Ardia quits (`vaultLockOnQuit`, default on) is off.
  Then, when Ardia quits with the store open and Touch ID allowed, `VaultLockPolicy.recordQuit` writes an
  `unlocked-at-quit` marker through `VaultKeychain` (data-protection keychain, this device only) naming the open
  managers and the boot session (`kern.bootsessionuuid`, which a clock change can't shift), signed with an HMAC key kept
  in the same keychain. Turning the option off also stores that choice there (`stays-open-at-quit`), because
  `resumeAfterQuit` runs before JS sends the settings. At launch `VaultsModule`'s `OnCreate` runs
  `VaultBroker.resumeAfterQuit`, which reads and deletes the marker, and only when its signature verifies, the stored
  choice says stay open and it's the same boot, opens the store from the files and publishes those managers as
  unlocked, before the first menu. It doesn't count as an owner check, so CLI sessions come back on the next unlock.
  Builds without the access group (ad hoc, development signed) never resume. A restart, turning the option back on, Lock, Lock All and the idle lock delete the
  marker. Sign Out deletes its file here and in iCloud; a CLI reporting signed out, or a different account, deletes
  only this Mac's file.
- **The key.** A random 256-bit key in the data-protection keychain under the app's `…​.passwords` access group,
  synchronizable, so iCloud Keychain carries it to the owner's other Macs (`VaultStoreKey`). Builds without that
  entitlement keep a local key (`vault-cache-key`) where their other secrets live (below). Builds with the access
  group read store keys, the retired list and the quit marker only from the data-protection keychain, never an
  old-style login-keychain item (anything running as the user could plant one), and never promote a local key to the
  synced one. A pull checks the synced item's modification date (attributes only) and reads the key again only when
  it changed. A new Mac
  never makes its own synced key while `iCloud Drive/Ardia/Password Managers` already holds sealed files: it seals
  locally with a local key and waits for iCloud Keychain to bring the real one. When the synced key changes (iCloud
  Keychain resolved two Macs' keys), older files still open: every key this Mac makes or adopts, synced or local, is
  first added to its key ring in `vault-retired-keys` (this Mac only, `VaultKeyRing`), and a key that can't be added
  there is never sealed with. A file opened with a past key is resealed with the current one as soon as it's read
  (the local store files, and the iCloud copy on the next pull). A hidden test instance uses its sandbox file, and the `vaultSyncedKey=<file>`
  test value stands in for the synced item.
- **Where secrets live.** `VaultKeychain` picks one place at launch (`VaultSecretPlace.choose`) and never falls back
  to another:

  | Build | Place | Trusted |
  | --- | --- | --- |
  | Has the `…​.passwords` access group (release, team profile) | Data-protection keychain only | yes |
  | No access group, not team-signed (ad hoc) | `<data dir>/Password Managers/Keychain.sealed` | no |
  | No access group, team-signed (`DevSigned.xcconfig`) | Login keychain (service "Ardia Password Managers") | no |
  | Hidden test instance | `<data dir>/Password Managers/Keychain.sealed` | yes |
  | Hidden test instance with no data dir | Memory only | no |

  The access-group place never touches the login keychain: no reads, no writes, no clean-up, so it can't raise the
  "wants to use your confidential information" dialog. Items older builds left in the login keychain stay there,
  unread; delete "Ardia Password Managers" items in Keychain Access to remove them. The sealed file is AES-GCM with a
  random per-data-dir key in `Keychain.key` beside it (both 0600, the folder 0700, excluded from backups, written to a
  new file and renamed). That is weaker than the keychain: anything running as the user can read both files, so it
  only keeps the secrets out of plain sight. It is allowed only in builds with no access group and no team signature.
  It never reads, moves or deletes the login-keychain items earlier ad hoc builds left (reading them would ask for the
  login password); store files sealed with that old key stay as `.vault.held` until a build that has the key (a
  development signed build on the same data dir) opens them. An ad hoc build's Touch ID copy of a session is gone
  after the switch, so the next unlock asks for the master password once. A file that doesn't open with its key, or whose key
  file is gone, is moved to `Keychain.sealed.unreadable` (then `.unreadable-2`, never over an earlier one); a key file
  that exists but can't be read leaves everything in place and the secrets unavailable. A store key that exists but
  can't be read is never replaced with a new one: only a definite not-found makes a key (`VaultStoreKeyPlan`). Untrusted places never resume after quit. Existence checks are attribute-only: one
  listing of the service answers every "is it there" (a failed listing falls back to one attribute query per item),
  and nothing reads a secret to see whether it exists. Each value is read at most once and kept in memory until Lock
  All, the idle lock or screen lock (`VaultKeychain.forgetValues`); the Touch ID copy of a session is never kept, in any place. A write
  of an unchanged value is skipped, and a write updates the item in place (`SecItemUpdate` with only the data), so a
  login-keychain item keeps its access list and its Always Allow. `usage_counts` carries `vault_keychain_reads`,
  `vault_keychain_reads_from_memory`, `vault_keychain_writes_skipped` and `vault_login_keychain_calls` (zero on any
  build with the access group).
- **iCloud.** With Sync with iCloud on (`vaultICloudSync`, on by default) and a synced key, each sealed file is also
  kept in `iCloud Drive/Ardia/Password Managers/<id>.vault` (`VaultCloud`). Every exchange is a merge, never a
  replace: read the iCloud copy and any conflict versions iCloud kept (`NSFileVersion`), merge them with this Mac's
  file, write this Mac's file if it changed, write the iCloud copy if it differs (coordinated, and only if nobody wrote
  it since the read), then mark the conflicts resolved. A manager's file keeps the item list of the newest fetch (the
  manager is the truth, so a deleted item stays deleted) and every password and code secret either Mac holds for an
  item whose `updatedAt` matches; another account's file is never mixed in. Until the manager's account is known
  (from its state or the account the local snapshot was saved for), nothing is pulled or pushed for it
  (`VaultCloudAccount`). `ardia.vault` merges entry by entry (see
  [Backup](#ardia-backup)). Pulls run when the store opens, on Sync, and 1.5 s after iCloud reports a change: a file
  presenter on the folder (`NSFilePresenter`, no polling), handled only while the store is open; pushes run 2 s after a
  local change, even while locked. A copy iCloud hasn't downloaded yet starts a download and is merged when it arrives,
  so an unlock never waits on iCloud. Offline, writes land in the local iCloud Drive folder and upload later. Nothing is
  written to iCloud while the key there is one this Mac doesn't have, or while this Mac has only a local key; a damaged
  iCloud copy is moved to `<id>.vault.damaged` before this Mac's merge replaces it. Repeated failures log once. Files over 64 MB and more than 8 conflict
  versions per file are not read. Only the conflict versions actually merged (or found damaged) are resolved, one by
  one; one sealed with a key this Mac doesn't have yet stays for later and the row says Waiting for iCloud Keychain.
  Files with a well-formed sealed header, and files iCloud hasn't downloaded yet (`.<id>.vault.icloud`), count toward
  "iCloud already holds sealed files". A copy a newer Ardia wrote is merged into this Mac's file but never written back
  ("Update Ardia to keep syncing"). Signed out of iCloud (`ubiquityIdentityToken` nil) reads as iCloud off, and a
  sign-in change re-presents the folder. Turning
  the setting off only stops this Mac syncing and backing up (and drops the backed-up logins from this Mac's
  `ardia.vault`); the iCloud copy stays for the other Macs. The row's ⋯ menu has Delete iCloud Backup…: a confirm
  ("Delete Passwords from iCloud?", Cancel the default), the owner check, then `vaults.deleteBackup` writes
  `.ardia-backup-deleted` (a timestamp sealed with the synced key) in the folder and removes Ardia's files. A Mac that
  sees a marker that opens stops syncing and keeps its own data; Settings shows "Another Mac deleted the backup" with
  Turn On Again (`vaults.resumeBackup`, removes the marker). A marker that doesn't open is ignored. A hidden instance syncs only to a folder given as the
  `vaultCloudDirectory` test value.
- **Sync.** Settings › Profiles › <profile> › Passwords › For All Profiles › Sync Now (`vaults.sync`) unlocks first if everything is locked,
  merges with iCloud, forces each connected manager's list to refresh from its CLI (skipping the provider's own
  throttle), merges again and backs up Ardia's logins. The row shows when the store last synced.

`vaults.providers` answers at once from the cached states (or a placeholder: `notInstalled` when no binary is found,
otherwise `locked`) and starts one background refresh, which emits `vaults.changed` for each state that differs.

## Security model

1. **Secrets stay native.** Passwords, saved form passwords, master passwords, API keys and session keys never reach
   JS, an event payload or a log. JS sees item metadata (id, title, username, urls, hasTotp, vault name) and one-time
   codes. Error text from a CLI is reduced to its first line, stripped of log prefixes, capped at 240 characters, and
   any secret Ardia passed to that command is replaced with `[hidden]`. The sign-in and unlock sheets type master
   passwords, client secrets and access tokens into `ArdiaVaultPasswordField` with an `entry` token: the field keeps the
   value in `VaultSecretEntries` (native, at most 16, dropped by `dropEntry` when the sheet closes), and JS sends only
   the token (`passwordEntry`, `clientSecretEntry`, or the token as `unlockVault`'s password), which native resolves.
   A token native no longer holds (dropped, or the oldest past 16) resolves to no secret, never to the token itself,
   and an empty field resolves to no secret rather than an empty password.
   A revealed password edits through `VaultRevealedFieldEditor`: no spelling or grammar checks, autocorrect, text
   replacement, completion, inline predictions or Writing Tools; its selection never reaches a pasteboard, a drag or
   Services; and Copy and Cut go through `VaultClipboard` (concealed, this Mac only, cleared after 90 s).
2. **Fill checks.** `VaultBroker.fillValues` refuses unless the origin is https (or http on localhost, 127.0.0.1 or
   ::1), the manager is unlocked, the item exists in a fresh list, and one of the item's URLs matches the origin
   at the subdomain tier or better (see Site matching below). The
   person choosing an item from search (`userChose`) skips only the URL match, never the https rule. The origin
   comes from the native VerifiedOrigin of the frame, and the page script checks `location.origin` again at fill time.
   The page script fills only fields a person can see: never one that is disabled, read-only, smaller than 8 px,
   placed off the page, transparent (its own opacity and `filter: opacity()` times its ancestors' below 0.05),
   clipped or masked (`clip-path`, `mask-image` on the field), inside a clipped box under 8 px, covered at its center
   by another element (`elementFromPoint`, except its own label or an ancestor such as a shadow host), `aria-hidden`,
   `inert` or in a search form, so a page can't hide a password field next to a visible one. The page script runs in
   the page's own world, so everything it decides with is captured when it installs: DOM and event getters (key and
   modifier keys, input type, disabled, read-only, parent nodes, text, computed style values) and the language
   built-ins (`parseFloat`, `Math`, `String`, `RegExp.prototype.exec`, `WeakSet` and `WeakMap` methods, the
   `HTMLInputElement` constructor). Its lists are arrays with no prototype walked by index, so a page that later
   replaces `Array.prototype` methods, the array iterator or a global changes nothing it decides. Every message from
   native is copied in `receive` onto objects with no prototype (own properties only), so a page that sets
   `Object.prototype.submit`, `.context` or `.username` can't make a fill submit, move it to the right-clicked field or
   add a value. `vault-page-script.test.mjs` also runs the whole `page_script.js` in `node:vm` over a small DOM and
   fills through its own `receive`, with the prototype polluted and `JSON.parse` and `Reflect.apply` swapped after
   install. It ignores focus
   events the page dispatches itself. One focus, click or fill reads each element's style once
   (`vaultInOnePass`), however large the form.
   ArdiaCore installs the page script in each frame's main world when its script context is created (or at document
   start), before any of the page's own scripts run, so the captured getters are the browser's. A frame created before
   the renderer has the script gets no page script at all, so it never sends keys or fields. Menu keys therefore count
   only from trusted keydowns read through those getters, and the arrows and Return work on every row, sibling logins
   and username rows included, as in Safari. A Touch ID touch acts on whichever row is selected, as a click would, and
   a login, code or username it fills is also submitted (a generated password isn't). The fingerprint shows on that row,
   and the page can't move the selection.
   `usage_counts` carries `vault_fills`, `vault_fills_refused_for_site` (`originMismatch` or `insecure`),
   `vault_fills_offline` and `vault_fills_failed` from the fill menu and the context menu (counts only).
3. **Binaries.** Only fixed locations are searched (`/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`,
   `~/.npm-global/bin`, `/opt/local/bin`, `~/bin`). The path, its directory, the resolved target and the target's
   directory must be owned by root or the current user and not be world-writable, and the target must be a regular
   executable file. Ardia runs the resolved target it checked, not the link. Commands never go through a shell.
   Binaries aren't checked for a code signature (a CLI can be a node script with none), so a binary planted
   in one of these folders by something already running as the same user is trusted.
4. **Processes.** Each run gets an explicit environment: `HOME`, `USER`, `LOGNAME`, `TMPDIR`, proxy and CA variables
   when set, `LANG=en_US.UTF-8` (so error text is parseable), `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, then `/opt/homebrew/bin` and `/usr/local/bin` when they pass the
   locator's directory checks (so an npm-installed CLI finds `node`), then the binary's own directory, and the
   provider's variables. Stdin is `/dev/null`, or a pipe that is written and closed (with
   `SIGPIPE` off for that descriptor). Stdout and stderr drain concurrently; stdout is capped at 32 MB by default (a
   provider can pass a larger `outputLimit` for a big list; the process is stopped past it, and its output is dropped)
   and stderr at 1 MB. Every call has a
   timeout: terminate, then `SIGKILL` 2 s later, sent to the child's whole process group so anything it started stops
   too. Cancelling the calling task stops the process the same way, before or after launch, and quitting Ardia halts
   every command still running (`VaultCommand.haltAll`, from `VaultsModule`'s `willTerminate` observer).
   A reply that doesn't parse as the JSON a command promises is an error, never an empty list: a notice printed ahead
   of the JSON is skipped (`VaultJSON.parse` tries each `{`/`[` start), but garbage, a cut-off list or the wrong shape
   throws "<tool> sent a reply Ardia couldn't read", so nothing empty is cached, sealed or sent to iCloud from a failed
   read. Stdin is
   written off the timer's queue, so a CLI that never reads it still times out. Flags take
   their values in `--flag=value` form so an id or title can't be read as an option, and ids are validated before
   they reach argv.
5. **Secrets in argv: never.** A provider passes master passwords, API keys and tokens through that one process's
   environment (`cli.run(_:environment:)`), and new logins and edits as JSON on stdin. A provider whose CLI takes a
   value only on argv leaves that feature unsupported, except a short-lived two-step code.
6. **One call at a time per manager.** Every CLI call runs inside that manager's `VaultLane`, so two callers never
   race the same CLI (or invalidate each other's session). Concurrent item list requests share one fetch. A
   background list refresh yields to a fill: when a fill needs the CLI and a list is already cached, the refresh is
   cancelled (its sync or list process with it) and runs again on the next stale read. Lock, Lock All and Sign
   Out never wait behind CLI work: they forget the session and drop the cached list first, cancel the list, read-ahead
   and code fetches in flight, interrupt whatever holds the lane (`VaultLane.interrupt`), and run the CLI's own lock
   or logout ahead of anything queued (`VaultLane.runFirst`). Queued work then finds no session and stops at once, and
   a read that finishes after the lock is thrown away. Lock All locks every manager at the same time. A lock epoch
   (`VaultLockEpoch`, per manager and one for everyone) makes that hold for unlocks too: Lock, Lock All, Sign Out and
   Cancel bump it, and interrupt the lanes, before their first `await`. An unlock, sign-in or unlock from the store
   takes a ticket when it starts, and `settle`, `openStore` and the CLI's `remember` refuse a ticket that went stale,
   so an unlock that finishes during a lock can't reopen the store or keep a session. The session is written under
   the epoch's lock, so it lands before the lock's forget or not at all. A cloud pull re-checks its ticket and the
   manager's lock after its `await`, so a locked manager's secrets aren't brought back into memory. Every sign-in and
   unlock command registers as the manager's running command (`VaultCLI.runSigningIn`), so Cancel stops it, its
   whole process group with it.
   **No surprise prompts.** A provider whose CLI asks an app to authorize, where that authorization lapses after some
   idle time, sets `staysAuthorizedAfterUse` to that window. Background work (the stale-list refresh and reading ahead)
   runs for it only within that window after its last successful call, so visiting a site never pops up its prompt.
   **Reading ahead.** A manager whose list carries no passwords would need its CLI on a site's first fill.
   When a page with a visible password, username or one-time-code field loads (the page script's `vaultLoginPage`,
   once per document, at load, 1.5 s later and on the first focus of a login field, so a single-page app's later
   login form counts too; the event says whether it came from the top frame), and again when a manager unlocks or its list changes for an open login
   page, JS calls `vaults.warm {origin}`. The broker reads, through the lane behind every other call
   (`VaultLane.runBehindOthers`), the password and `otpauth://` URI of at most 3 logins that match that site and
   aren't already cached for their `updatedAt`, into the sealed store, at most once a minute per site. A fill that
   needs the CLI cancels a read in progress. The first fill on the site is then served from memory.
7. **Offline.** `VaultNetwork` watches the network path. Offline, a provider whose list and reads are local keeps
   working from its CLI and skips only its sync; a provider with `readsOffline` false skips its background refresh and
   its state check, keeps its last state with the message "You're offline. Saved logins still fill.", and a fill that
   would need its CLI answers `offline` at once. Fills from the cached list and passwords keep working for every
   manager. A manager whose state check fails while offline shows the same message.
8. **Touch ID copy.** For a provider with `capabilities.touchID`, with the Touch ID option on, the session is also
   stored where the build keeps secrets ([Where secrets live](#the-local-store); in builds with the access group the
   data-protection keychain with a `.userPresence` access control, read with the owner check's own `LAContext` so
   there's no second prompt). Reading it back first passes `LAContext` (biometrics, falling back to the Mac password),
   and the provider checks the session with its CLI before use. The stored copy is deleted only when the CLI answers
   locked or signed out; a check that fails, can't be read or is stopped by a lock keeps it for the next try. A touch
   on the fill menu's Touch ID view hands its evaluated `LAContext` to an unlock grant
   (`VaultOwnerCheck.grant(scope:context:)`), so that one touch also opens the keychain item; a fill grant's context is
   dropped. Any keychain failure degrades to memory only. This path needs no entitlement, so it works in ad-hoc and
   development signed builds. Turning the option off deletes every stored copy, and lock then also runs the
   provider's `lock`. With the option on, lock forgets only Ardia's in-memory session and leaves the CLI as it is, so
   the stored copy can resume; the only copy left is the keychain item behind `.userPresence`.
9. **Auto-lock.** After the idle timeout (default 30 minutes without a list, fill, copy, code or save), and on sleep,
   screen lock or fast user switch (while Lock when screen locks is on), every manager locks and `vaults.changed` is
   emitted. Every lock-all (idle, sleep, screen lock, fast user switch) also wipes every tab's captured logins and
   kept generated passwords (`ArdiaVaultCapture wipeAll`) and the save popover's password drafts. A generated password
   kept in a tab expires after 30 minutes on a timer, not only when read.
10. **Owner check before passwords.** With Ask before filling on (the default, `vaultAskBeforeFilling`, sent as
   `askBeforeFilling` in `vaults.setOptions`), `VaultBroker.fillValues` refuses any fill that includes a password, and
   `copy` refuses a password copy, until the Mac owner confirms with Touch ID or the login password
   (`VaultOwnerCheck`). A refused fill answers `notAuthorized` and the menu stays open with no error; a refused copy
   answers `declined` and shows no toast. Usernames and one-time codes don't ask. The fill menu also shows Apple's
   embedded Touch ID view (`VaultTouchIDView`, `LAAuthenticationView`) on the selected login, or the first one: a
   touch on the sensor grants the broker one owner check for 10 s (`VaultOwnerCheck.grant(scope:)`, `VaultTouchGrants`): the grant is single use and scoped to what the
   touch was for, which JS sends as the view's `grantScope`: `fill` with the manager, item, page origin and tab,
   `unlock` with the manager, `passkey` with the request and credential, or `autofill-card` with the card and tab.
   JS builds them in `state/vaults/touchScopes.ts` and native in `VaultTouchGrants`; both sides' tests check them
   against one table, `packages/ardiacore/tests/fixtures/vault-touch-scopes.json`. The view itself stays out
   of the accessibility tree; the menu row speaks for it. Only the two fill paths (`takeFillGrant`, with the tab set by the web view's fill as
   `VaultOwnerCheck.fillTab`) and that manager's unlock take it; export, iCloud restore, adding or removing a code
   and copying a password always ask. A grant never opens the 30 s presence window, except an unlock's. The window
   (`VaultPresence`, on the monotonic clock) holds the `LAContext` of the check that opened it, and only that one: a
   check with no context (the Chrome passwords pane) opens it with none, so no older context is ever lent out. Prompts
   are serialized, one at a time. A Touch ID lockout goes straight on to the password prompt. After an
   unlock from the fill menu, the next fill of that manager's login on the menu's own site and tab needs no second
   touch: `unlock` carries the menu's tab and origin, and `passOn` grants `fill-hand-on` with the manager, origin and
   tab, which covers only a fill with that manager, origin and tab. An unlock from Settings hands nothing on. JS drops an unused
   grant at once with `vaults.dropTouchGrant` and reports `granted` through the view's `onStatus`; JS fills
   the row that was armed at the moment of the match (`state/vaults/touchID.ts`), with no dialog, and asks the page to
   submit the form (`submit: true`); a click or Return never submits. It is one touch per step: on a username-only
   page the touch fills the username and continues, on the password page the password, and on the code page the code
   (code rows are touch rows too). A touch on a locked manager's Unlock row opens the store and, when the site then
   has exactly one login or code row and it is one that fills without a choice (not a sibling subdomain's), fills it
   with the same touch (the broker grants again after the unlock); a click on Unlock does the same without submitting.
   With two or more logins, or only a login that needs an explicit pick, the menu stays open with the highlight on the
   resting row and nothing is filled (`soleRestingFill` in `menuModel.ts`). The view reports `onStatus` (`ready` while the
   sensor listens, `retry` after a finger that didn't match, `granted`, and the terminal `unavailable` and
   `lockout`), which the row shows as the glyph, a red shake with Try Again, and a check. It listens only while the
   app is active and its window is key, re-arms after a system cancel (backing off to 2 s after five in 3 s), and
   ignores replies from an older attempt. Apple's glyph is drawn transparent and the row shows
   the `touchid` symbol in its own text colour instead. Without Touch ID, or after a lockout, Return or a click asks through the system prompt instead.
   `vaults.biometrics` says whether Touch ID can be used.
11. **Clipboard.** Usernames and passwords are copied; a one-time code is copied only from Settings › Profiles › <profile> › Passwords
   (an Ardia login's Copy Code, or a standalone code's row or sheet, `vaults.copyCode`), and is otherwise filled. Copies are marked `org.nspasteboard.ConcealedType` and `org.nspasteboard.TransientType`, and the
   pasteboard is cleared 90 s later (a wall-clock deadline, checked by a timer and again on wake and when Ardia
   becomes active, since timers stop during sleep) if nothing else was copied since, or when Ardia quits sooner.
   Copies are `.currentHostOnly`, so they don't reach other devices through Universal Clipboard, and carry an
   Ardia marker kept in UserDefaults: after a crash, the next launch clears a copy still holding that marker. Settings' Copy
   Password for an Ardia login goes through `vaults.copy` (no second prompt within 30 s of unlocking the pane, which
   counts as an owner check); with Ardia off for that profile it copies the shown password with `vaults.copyConcealed`. Every copy (the command bar's Copy Username and
   Copy Password, and both buttons in Settings › Profiles › <profile> › Passwords' login sheet) goes through `vaults.copy`, which answers
   `copied` only once the pasteboard reads the value back; otherwise `declined` (the owner check was refused) or
   `error` (`locked`, `notFound`, `clipboard`, ...), shown as a toast or under the sheet. The command bar copies the
   login filled in that tab, else the one used last on the site, else the best match.
12. **Test instances.** In a hidden test instance (`ARDIA_BACKGROUND=1` with `ARDIA_DATA_DIR`, `VaultSandbox`), binaries are looked up only in `<data dir>/Password Managers/bin`,
    each CLI gets its own state folder under `<data dir>/Password Managers/<id>` (the variables the provider returns
    from `isolatedEnvironment(_:)`), and the keychain copy goes to
    the sealed `<data dir>/Password Managers/Keychain.sealed` instead of the real keychain (an older plain
    `<data dir>/Password Managers.json` is sealed and removed on first use). In background mode the owner check never
    prompts (it answers from `ARDIA_TEST=reauth=granted`) and the Touch ID view never touches the sensor: it answers from `ARDIA_TEST=touchID=granted`, `retryThenGranted`,
    `lockout` or `unavailable`, and without one it shows ready and never grants. Copies go to a private pasteboard, and sleep or screen lock
    of the owner's Mac doesn't lock the test's vaults.

### Known limits

- Each vendor's own limits (items its CLI can't list, sign-in steps it has no flag for, which vault a new login goes
  into, fields it can't edit without argv) move with that vendor's plugin.
- Ardia's Sign Out runs the CLI's own logout, and lock with the Touch ID option off runs the provider's lock, so they
  also sign out or lock the person's own Terminal use of that CLI.
- CLI errors that mention a DNS, connection or certificate failure read as offline or server unreachable, and unknown
  options read as a CLI that is too old (`VaultMessages.failure`).
- A provider without `capabilities.edit` can't edit logins, so a changed password in it offers nothing.
- Until the engine hook ships, Chrome's login dropdown opens for a moment before the fill menu closes it (see
  [Chrome's dropdown](#chromes-dropdown)).
- Ardia's backup has no notes: Chrome's store read (`ac_passwords_logins`) returns the site, username and password only.
- When the same login is changed on two Macs while both are offline, the later change wins by each Mac's clock.
- Saving into a large Chrome store is slow (about 3 saves a second at 10,000 logins, so a 10,000-row CSV import takes
  close to an hour), and this is in the engine, not in Ardia's Swift: `ac_passwords_add` in
  `engine/chromium/src/chrome/browser/ardia/ac_passwords.cc` calls `WithList` (the delegate's
  `GetSavedPasswordsList`, every saved login converted to a `PasswordUiEntry` on the UI thread) before `AddPassword`,
  then `Settle` repeats that full list up to `kSettleChecks` times until the new login shows up, and each store change
  also makes `SavedPasswordsPresenter` rebuild its whole list. The fix: in `ac_passwords_add`, call `AddPassword`
  directly (it already refuses a duplicate), and settle by asking the profile store for that one signon realm
  (`PasswordStoreInterface::GetLogins` with a `PasswordFormDigest`) instead of the full UI list; and add
  `ac_passwords_add_many` taking an array of logins, saved with one `PasswordStoreInterface::AddLogins` batch (or the
  delegate's CSV `ImportPasswords`), so `importPasswordsCsv` and import's `apply.ts` send one call and get one refresh.
  Ardia's side already batches: the backup runs once, 3 s after the last save, and the Ardia index adds each save in
  place without listing again.
- A provider whose list has no one-time code flag leaves `hasTotp` unknown, and `vaults.totp` answers `null` when the
  item has none.

## Site matching

`VaultOriginMatch.swift` and `state/vaults/originMatch.ts` implement one rule set, checked against one table
(`packages/ardiacore/tests/fixtures/vault-origin-tiers.json`, read by both the Swift and the JS tests). Sites come from
the full Public Suffix List (ICANN and private sections, `*.` wildcards and `!` exceptions), generated as ASCII into
`VaultPublicSuffixRules.swift` and `state/vaults/suffixes.ts` by `node packages/ardiacore/scripts/public-suffixes.mjs`
from the copy in `apps/android/blocking` (run it after that copy updates). A saved URL's path, query and user info are
ignored, and a backslash counts as a slash as browsers parse it (`https://bank.com\@evil.com` is bank.com); hosts
compare lowercased, without trailing dots, with unicode labels in punycode. Only C0 controls and spaces are trimmed
from the ends (as the URL standard does; a no-break or ideographic space makes the URL match nothing), and `://`
starts a scheme only when everything before it is one (`example.com/login?next=https://other.org` is example.com). A
provider's URI match types are honoured (`urlMatch` on the item): Host needs the same host and port (sameHost or better), Exact and Starts With need the exact
origin, Regular Expression and Never URIs never match, Default and Base Domain use the tiers. Tiers, best first:

| Tier | When | Fills without a choice |
| --- | --- | --- |
| exact | same host, scheme and port (a URL saved without a scheme counts as https, any scheme on localhost) | yes |
| sameHost | same host, another scheme (http saved, https page) or a saved bare `localhost` on any port | yes |
| www | `www.` and the bare host, unless the bare host is a public suffix (`www.blogspot.com` is not `blogspot.com`) | yes |
| subdomain | one host is under the other, both under the same registrable domain | yes |
| sibling | different hosts under the same registrable domain (`accounts.example.com` on `mail.example.com`) | no |

A port saved with the URL must equal the page's; without one, only the default port (any port on localhost). IP
addresses match only exactly. Nothing matches across a public suffix: `alice.github.io` and `bob.github.io`, or
`a.co.uk` and `b.co.uk`, are different sites, while `app.alice.github.io` is under `alice.github.io`. Siblings rank
last, are labelled with their host, and always fill as the person's choice (`userChose`). They're the resting row only
when nothing matches the page's own site, and then a touch on the fingerprint fills and submits it. Natively a fill without `userChose` needs subdomain or better; with it, any
login on a secure page (search). Rows sort by tier, then the login used last on the site, then username; the same
username on the same host from two managers, or saved once for http and once for https, shows once (logins without
a username are never folded).

Scale, measured on the 2026-11-13 build with 12,600 logins over 3,000 sites (600 sites with 13 subdomain logins):
JS `rankItems` takes 1.3 ms of CPU per page (parse and site caches about 7 MB), `menuRows` 2.5 ms, and the native
broker matches a page in 0.04 ms through `VaultSiteIndex` (logins bucketed by registrable domain, built off the actor
when the list changes, about 45 ms).

## The JS surface

Calls (`call("vaults.<name>", args)`, typed in `packages/ardiacore/src/engine/api.ts`):

| Call | Args | Returns |
| --- | --- | --- |
| `providers` | `{}` | `VaultProviderState[]` |
| `refresh` | `{provider}` | `VaultProviderState` (drops the item cache, forces a sync on the next list) |
| `items` | `{provider?}` | `VaultItem[]` (empty for a locked manager) |
| `lock`, `signOut`, `cancelSignIn` | `{provider}` | `VaultProviderState` |
| `configure` | `{provider, server?}` | `VaultProviderState` (`message` says why a change was refused) |
| `copy` | `{provider, id, field: "username" \| "password"}` | `{copied, clearsAfter}` |
| `totp` | `{provider, id}` | `{code, period, expiresAt} \| null` |
| `generate` | `{style?, maxLength?}` | `{length}` |
| `setOptions` | `{idleLockMinutes, touchID, askBeforeFilling, iCloudSync, lockOnQuit, lockOnScreenLock}` | `{}` |
| `listGenerated` | `{}` | `{id, origin, username, createdAt, submitted}[]`, newest first, never the password |
| `copyGenerated`, `deleteGenerated` | `{id}` | like `copy`; `{deleted}` |
| `saveGenerated` | `{id, provider, username?, profile?}` (`profile` names Ardia's target profile) | `{saved, item?, error?}` (`error: "needsUsername"` when neither the entry nor the call has one) |
| `setGeneratedRetention` | `{days}` | `{}` (`-1` Until Deleted, `0` Never) |
| `edit` | `{provider, id, username?, passwordDraft?, url?, totp?}` (`passwordDraft` a `VaultPasswordDrafts` token, `totp` `{token}` from code setup or `{remove: true}`) | `{edited, item?, error?, message?}`: see Editing logins; `error` is `locked`, `notFound`, `unsupported`, `invalid`, `declined` or `failed` |
| `newPasswordDraft`, `dropPasswordDraft` | `{style?}`; `{token}` | `{token, length}`: a draft for Settings' password field, empty or generated natively (`VaultPasswordDrafts.blank`); it outlives the field and is dropped by the sheet, a save, or a lock-all |
| `createLogin` | `{website, username?, passwordDraft, profile?, codeToken?}` | `{saved, codeAdded, item?, error?}`: New Password; `error` is `exists`, `invalid`, `needsPassword`, `expired`, `declined` or `failed` |
| `codes` | `{}` | `{id, label, issuer?, website?, period?, createdAt?}[]`: the standalone codes, never their secrets |
| `addCode` | `{token, label, issuer?, website?}` | `{added, code?, error?, id?}`: `error` is `expired`, `invalid`, `exists` (with the saved code's `id`), `declined` or `failed` |
| `editCode`, `deleteCode` | `{id, label, website?}`; `{id}` | `{saved, code?, error?}`; `{deleted, error?}` (Delete asks the owner check) |
| `addTotp` | `{provider, id, token}` | `{added, item?, error?, message?}`: stores the code a right-click found (the token names it natively) in that login; `error` is `locked`, `notFound`, `unsupported`, `invalid`, `expired`, `declined` or `failed` |
| `export` | `{provider, profile?}` (`ardia`: Chrome's export of that profile) | `{saved, count, declined}`: the CSV (`name,url,username,password,otp`, RFC 4180) goes straight to the file picked in a save panel (0600); passwords never reach JS. A hidden test instance writes `<data dir>/<Manager> Passwords.csv` and logs the path |

Secret functions (`packages/ardiacore/src/vaults.ts`): `signInToVault(provider, fields)` and
`unlockVault(provider, password | null)`, both resolving to a `VaultSignInResult`. The sign-in fields
(`VaultSignInFields`) are generic: `email`, `password`, `code`, `method`, `server`, `clientId`, `clientSecret` and
`account`, each optional, and a provider reads the ones its sign-in uses. A result that isn't signed in says what
comes next in `needs`: a password, a code (with `methods` to pick from, sent back as `method`), or an approval (with
`approvalURL` to open in a tab, and `vaults.changed` follows when the CLI finishes).

`passwordEntry` and `clientSecretEntry` name a native secret entry instead of the value (see Security model), and
`unlockVault(provider, "entry-…")` resolves an entry the same way.

The sign-in sheets in Settings › Profiles › <profile> › Passwords (`PasswordManagerSheets.tsx`, `BitwardenSheet.tsx`,
`state/vaults/signInFlow.ts`, `servers.ts`, `brands.ts`, parts in `vaults/VaultSignInParts.tsx`) are still the
bespoke per-vendor sheets, but nothing registers a provider for them now; they will be replaced by one generic
sign-in sheet driven by the sign-in methods a plugin declares. What carries over is their shape: the manager's badge and name, an optional one-line status, grouped
rows with a fixed label column, errors under the field that caused them (`state/vaults/signInFlow.ts`
`placeSignInError`, else under the form), Cancel then the primary action on the right, and progress inside the
primary button. Empty secret rows show a Required placeholder drawn in JS beside the native field, and the focused field gets an accent ring (the native field reports focus with `onFocusChange`). Steps cross-fade and the sheet's height follows its content (220 ms ease-in-out; fade only with
Reduce Motion). Return submits, Escape cancels, Tab and Shift-Tab walk the fields. A missing CLI shows its install
command with Copy and Check Again. Cancel, closing Settings, or replacing the sheet while a sign-in or unlock runs (or
while a sign-in waits on a browser approval) cancels it natively, and an answer that lands after that is dropped
(`signInRequest.ts`, `cancelProviderSignIn`). Telemetry: `vault_sign_ins`, `vault_sign_in_failures`,
`vault_sign_in_two_step`, `vault_sign_ins_cancelled`, `vault_unlocks_typed`, `vault_unlock_failures`, `vault_cli_checks`.

`unlockVault(provider, null)` means Touch ID: the provider's stored Touch ID copy, its desktop app's approval, or the
Mac owner check, whichever the provider uses.

A standalone code's id starts with `code.`, so `totp`, `copyCode` and a fill with `provider: "ardia"` take it too.

Events: `vaults.codesChanged` `{}` (the standalone codes changed, here or through iCloud), `vaults.changed` `{provider: VaultProviderState}`, `vaults.itemsChanged` `{provider}` and `vaults.generatedChanged` `{}`.

## Adding a password manager

Credential providers will arrive as plugins: a `contributes.credentialProvider` manifest contribution, running its CLI
through host services, replaces in-tree providers, and the official `1password`, `bitwarden` and `protonpass` plugins
come that way. Until the plugin bridge lands, a provider is a Swift type in `packages/ardiacore/ios` registered in
`VaultRegistry.providers`, and the bridge will reuse the same machinery (`VaultProvider`, `VaultCLI`, `VaultCommand`,
`VaultBinaryLocator`, `VaultSandbox`, `VaultSessionStore` and the sign-in plumbing). What a provider implements today:

1. **Learn the CLI.** Find where it installs, how it reports signed in and locked, which commands list logins and
   fetch one secret, how it creates a login, and which commands can wait for a person (a prompt, a browser, Touch ID).
   Find a way to pass every secret through the environment or stdin.
2. **Conform to `VaultProvider`.** `id`, `name`, `binaryName`, `install`, optional `setup`, and the calls `state`,
   `signIn`, `unlock`, `signOut`, `items` and `secret`. `lock`, `configure`, `revealed`, `save`, `addTotp` and `edit`
   have defaults (`save`, `addTotp` and `edit` throw `unsupported`). Keep it stateless: anything a manager needs to
   remember goes through `VaultCLI` (`remember(session:)`, `value`/`setValue` for values that last until the next refresh or lock, `preference`/`setPreference` for values that last until sign
   out).
3. **Declare `capabilities`** (`VaultCapabilities`): `totp`, `save`, `selfHosted`, `masterPassword`, `touchID`,
   `addTotp`, `edit`, `desktopApproval` (its unlock asks the person, so it is never reconnected quietly in the
   background) and `passkeys`. The broker and JS decide from these, not from the provider's id. Set `readsOffline` false when its
   list or reads need the network, and `staysAuthorizedAfterUse` when its CLI's authorization lapses after idle time.
4. **Map errors with `checked`.** Give it the lowercase substrings that mean locked, signed out and not found;
   everything else becomes a cleaned, redacted failure message.
5. **Parse defensively** with `VaultJSON` (missing fields, numbers as strings, dates in any of the common forms) and
   build `VaultItem`s with metadata only. Read whole replies with `VaultJSON.list`/`record`, which throw on an
   unreadable reply, so a broken reply is an error and never an empty vault. Drop secret fields as soon as you've read
   what you need.
6. **Hold passkeys, optionally.** A provider that keeps passkeys declares `capabilities.passkeys` and conforms to
   `VaultPasskeyHolder` (`VaultBroker+Passkeys.swift`): `passkeySigner(cli, item:, credential:)` returns a signer for
   a stored passkey, and `savePasskey(cli, credential:, attachTo:, title:, url:)` stores a `VaultNewPasskey` and returns
   its item id.
7. **Test it against a fake CLI** in a Swift Testing suite. The suites run from
   `packages/ardiacore/tests/vault.test.mjs` through the `swift-testing.mjs` harness beside it
   (`pnpm -C packages/ardiacore test`); CI sets `ARDIA_SWIFT_TESTING=required` in
   `.github/workflows/mac-packages.yml`, so a missing Swift Testing fails instead of skipping. Answer each command
   with canned output (good JSON, a notice, partial JSON, garbage, a hang, endless output, a non-zero exit).
8. **Add it to `VaultRegistry.providers`.**
9. **For test instances**, return the CLI's state-folder variable from `isolatedEnvironment(_:)` so a hidden instance
   never touches the person's real session.

```swift
import Foundation

struct ExampleVault: VaultProvider {
  let id = "example"
  let name = "Example"
  let binaryName = "example-cli"
  let capabilities = VaultCapabilities(totp: true, save: false, selfHosted: false, masterPassword: true, touchID: false)
  let install = VaultInstall(command: "brew install example-cli", url: "https://example.com/cli")
  let setup: VaultSetup? = VaultSetup(kind: .credentials)

  private static let tool = "Example CLI"

  func isolatedEnvironment(_ directory: String) -> [String: String] { ["EXAMPLE_CONFIG_DIR": directory] }

  func state(_ cli: VaultCLI) async -> VaultProviderState {
    let result = await cli.run(["status", "--json"])
    guard result.succeeded, let status = try? VaultJSON.record(result.stdout, from: Self.tool) else {
      return makeState(.unavailable, message: VaultMessages.failure(result, tool: Self.tool))
    }
    guard VaultJSON.bool(status["signedIn"]) == true else { return makeState(.signedOut) }
    return makeState(cli.session == nil ? .locked : .unlocked, account: VaultJSON.string(status["email"]))
  }

  func signIn(_ cli: VaultCLI, fields: VaultSignInFields) async -> VaultSignInResult {
    await unlock(cli, password: fields.password)
  }

  func unlock(_ cli: VaultCLI, password: String?) async -> VaultSignInResult {
    guard let password else { return needs(.password) }
    let result = await cli.run(["unlock", "--password-env", "ARDIA_EXAMPLE_PASSWORD"], environment: ["ARDIA_EXAMPLE_PASSWORD": password])
    guard result.succeeded else { return failed(VaultMessages.failure(result, tool: Self.tool, redacting: [password])) }
    cli.remember(session: result.trimmedOutput)
    return signedIn()
  }

  func signOut(_ cli: VaultCLI) async {
    _ = await cli.run(["logout"])
  }

  func items(_ cli: VaultCLI) async throws -> VaultItemList {
    guard let session = cli.session else { throw VaultError.locked }
    let result = await cli.run(["list", "--json"], environment: ["EXAMPLE_SESSION": session], timeout: 60)
    try check(result)
    let items = try VaultJSON.list(result.stdout, from: Self.tool).compactMap { entry -> VaultItem? in
      guard let itemId = VaultJSON.string(entry["id"]) else { return nil }
      return VaultItem(provider: id, id: itemId, title: VaultJSON.string(entry["title"]) ?? "",
                       username: VaultJSON.string(entry["username"]) ?? "", urls: VaultJSON.strings(entry["urls"]))
    }
    return VaultItemList(items: items)
  }

  func secret(_ cli: VaultCLI, id: String, field: VaultField) async throws -> String {
    guard let session = cli.session else { throw VaultError.locked }
    let result = await cli.run(["get", field.rawValue, "--id=\(id)"], environment: ["EXAMPLE_SESSION": session])
    try check(result)
    guard !result.trimmedOutput.isEmpty else { throw VaultError.notFound }
    return result.trimmedOutput
  }

  private func check(_ result: VaultCommandResult) throws {
    try checked(result, tool: Self.tool, locked: ["locked"], signedOut: ["not signed in"], missing: ["not found"])
  }
}
```

Then in `VaultRegistry.swift`:

```swift
static let providers: [any VaultProvider] = [ExampleVault()]
```

What the core already does for the new manager, so the provider must not repeat it: finding and vetting the
binary, the environment, timeouts and output caps, one call at a time, the state and item caches, `vaults.changed`
and `vaults.itemsChanged`, idle and sleep lock, origin checks before a fill, the clipboard, and dropping the session
when the CLI reports locked or signed out.

## Filling and saving

- **Generated passwords.** `VaultPasswordGenerator` makes four styles (`strong`: four groups of five joined by
  hyphens; `alphanumeric`: 20 letters and digits; `easyToType`: lowercase and digits only, no Shift; `passphrase`:
  five words from the EFF Short Wordlist 1, one capitalized, one digit; four when the field is short). When the field's `maxlength` is shorter, the
  style shrinks or falls back to letters and digits of that length. The password never leaves native code.
- **Submitting.** With `submit: true` the page script waits two frames, checks the origin and form are unchanged and
  nothing required is still empty, then clicks the form's sign-in button, or calls `requestSubmit()`, or presses
  Enter on the last field. At most once per fill.
- **Saving new passwords.** A submission carries `newPassword`, `generated`, `usernameFrom` (`form`, `step`, `page`,
  `nearby` or none) and `trusted` (a real click on that form's own submit control, Enter in one of its fields, or
  our Touch ID submit; a page's own `requestSubmit()` is not, even right after a click somewhere else on the page). With Save new passwords automatically on (`vaultAutoSave`, default on) a password saves at once to the
  default manager only when it was generated, or is a new password from a trusted submit with a username from the
  form or an earlier step, that username isn't saved for the site yet, one manager is the target, and nothing was
  saved automatically on this page load. The target is Save new logins to (`vaultSaveTarget`), which lists only
  connected managers (unlocked or locked) that can save; with exactly one connected, that one is the default and
  saves go to it. Ardia counts as connected, so with no choice the one connected CLI manager is the default, and Ardia
  is when no CLI manager is connected. Every other new password gets the save popover, prefilled with the best
  guess (the page's username, then the login last used on the site, then the last username filled in the tab) and
  asking for an email or username when there is none; it sends the `username` override. Identical submissions while
  a save runs are ignored.
- **Waiting for the sign-in to work.** A submission whose page reports outcomes (`reportsOutcome`) waits up to 8 s for
  the page to say whether the login worked; no answer means no offer. A navigation is not a success by itself (a form
  that POSTs and redirects back to its own login page failed): when the tab navigates meanwhile, the wait restarts for
  10 s (`NAVIGATED_OUTCOME_MS`) for the landing page's answer. Native asks the new page whether a login form with a
  password field shows again there and reports that, reports success when the landing page is another site or doesn't
  answer within 8 s, and silence past the 10 s means no offer. A single-page app that changes its URL or drops the
  password field reports success without navigating. Telemetry: `vault_logins_failed_after_navigation`.
- **The save popover.** When it asks for an email or username, the field suggests usernames used before
  (`previousUsernames`, emails first; ↑↓ pick, Return or Tab accept, a click too) and starts with the best one. Below it
  is the password, editable in a native field with a show/hide eye: `stageVaultPassword({origin})` on the tab copies
  the captured login into a draft and returns `{token, length}`; the `ArdiaVaultPasswordField` view takes the token,
  shows the draft in an `NSSecureTextField` (an `NSTextField` while shown) and writes each edit back into the tab's
  captured login (and into a kept generated password), so Save sends the edited password through the usual
  `saveToVault`. JS only learns the length, which keeps Save off while the field is empty.
- **Generated passwords that aren't saved.** Every password Ardia generates into a field is kept in
  `<data dir>/Password Managers/Cache/generated.vault` (sealed like the store, name `store/generated`, 0600, excluded from backups; an older build's `Generated.vault` beside it is merged in once and removed after the copy reads back,
  never in iCloud; a hidden instance keeps it in its data dir) until it's confirmed saved in a manager: a
  `saveToVault` or `saveGenerated` that succeeds with that password for that site removes it. Anything else keeps it:
  no submit, a submit that saved nothing, no username, a failed, declined or dismissed save, no manager unlocked that
  can save, an auto-save that didn't happen. Generating again on the same site before submitting replaces the unused
  one; a submit marks it `submitted` and records the username. Keep generated passwords (`vaultKeepGenerated`: 1, 7
  (default) or 30 days, Until Deleted, Never) sets how long; expired ones are purged when the setting arrives at launch,
  on every read and hourly, and Never keeps none. The fill menu's Other Passwords… lists them first; filling one asks
  the owner check like any password and fills both the current and new password fields.
- **The field key.** A focused login field in the main frame on a secure origin, in a profile whose password manager
  shows a key (Ardia with a source, or a `fill: "system"` plugin), gets a key. The two kinds are drawn differently.
  On a `fill: "system"` plugin profile the key is the in-page one the page script's field-provider kit draws, with its
  panel hints, as main has it; a click opens the macOS Passwords panel through `passwords.showSystemPanel` (`{tab,
  generation}`) and its native guards (window key, page first responder and editing, a fresh focus check, 0.6 s
  throttle, generation). The rest of this bullet is the native glass badge, drawn only for Ardia profiles (menu mode),
  in Chromium tabs only: a
  small button inside its trailing edge (leading edge in a right-to-left field): `key.horizontal.fill`, mirrored so its
  teeth face right, for username, email and password fields, the same key led by a plus for new-password fields, `123.rectangle` for code
  fields (`house.fill` and `creditcard.fill` are mapped for address and card fields once those report). Ardia draws
  it in the page overlay above the web view (`VaultFieldBadge`, model in `state/vaults/fieldBadge.ts`), never in the
  page, so the page can't read, restyle or click it. It shows the same whether or not anything is saved for the site.
  The tile is 62% of the field's height (18 to 24 pt), centred on the field's content box, inset from the trailing
  edge by the field's own border plus padding (2 to 16 pt, else 6 pt). It's at least square, and the glyph is placed by its
  measured ink box (a table measured at 2x per point size), centred with equal side padding, on the 2x pixel grid. At
  rest only the glyph shows; on hover a plate appears (glass with a hairline and small shadow when Translucent Password
  Menu is on, a flat tint when off); open, the plate takes the accent colour with a white glyph.
  Its geometry comes from the page script's vault kit, which detects login and code fields, measures them and reports
  `vaultField` to native instead of drawing in the page (Chromium only; WebKit tabs send no `vaultField`).
  Placement comes from the field rect and insets the kit reports, which are untrusted: native clamps insets
  to 0 to 256, and non-finite, negative or oversized rects, fields under 20 pt tall or too narrow to hold text, and
  tiles not fully inside the web view show nothing. The kit also reports `rtl`, `darkField` (the first
  opaque background behind the field, or null; the tile follows it, else the app's appearance) and `trailingTaken`
  (something else is hit-tested at the tile's spot, such as the page's own icon or Ardia's reveal eye, or the field
  draws a background image in a wide trailing padding); a taken edge hides the tile. It re-reports on scroll and
  resize (one per frame) and when a password field's typed state flips, which is when the reveal eye comes and goes.
  A click toggles the menu for that field (`toggleVaultMenuFromBadge`, counted as `vault_menu_opens_from_icon`) like a click in the field, so it opens on
  autofocused fields too, and closing that way counts as declining. A second click within 300 ms is ignored, so a
  double click settles open. It fades in over 120 ms and scales down slightly when pressed; Reduce Motion drops the
  press scale. Subframe fields never get it (their rect isn't
  reported, and the menu needs it).
- **Auto-submit only after Touch ID.** Native honours `submit` only when that fill used a fresh Touch ID grant.
- **Suggest.** The For All Profiles block's Suggest is one row of checkboxes for what the fill menu and
  the right-click menu offer, all on by default: Saved Logins (`vaultSuggestLogins`: the site's logins, and their
  Username and Password in the right-click menu), Verification Codes (`vaultSuggestCodes`: code rows, and Verification
  Code in the right-click menu), Previous Usernames (`vaultSuggestUsernames`), New Passwords
  (`vaultSuggestNewPasswords`: the four generators in new-password fields, Suggest New Password in password fields,
  and Generate Password ▸ on a right-clicked password field), with New Passwords in Any Text Field
  (`vaultContextGenerate`, off by default, disabled while New Passwords is off) nested under it for Generate Password ▸
  on every other text input, and Generated Passwords (`vaultSuggestGenerated`: the kept generated passwords at the top
  of Other Passwords…). Below them, When a login field is focused is Suggest on Focus (`vaultSuggestOnFocus`). An
  unchecked kind disappears from both menus (`suggestOf` in `state/vaults/menuModel.ts`, read by `menuRows` and
  `contextMenuModel`); a login whose every choice is unchecked leaves the right-click list, a manager's Unlock row
  stays only while something it unlocks is still offered, and Other Passwords… (an explicit search) always lists every
  login. With Saved Logins and Verification Codes both off, the right-click menu has no Autofill ▸.
- **Right-click Autofill.** Right-clicking any text input (`contextmenu`, captured per frame by the page script, which
  keeps that element as the frame's context field and posts `vaultContext`) adds Autofill ▸ to the page's context
  menu right after the editing commands (after Select All, else at the top): one submenu per matching login (the fill
  menu's ranking, at most 8, titled with the account and the site, and the manager when two share a title) with
  Username, Password and Verification Code (only when `hasTotp` is true), then Unlock Passwords… while a manager is
  locked and Other Passwords… while one is unlocked. Autofill ▸ is there whether or not a manager is connected: with
  none connected it holds a disabled No Saved Logins, with a manager unlocked but nothing for the site No Logins for
  This Site, and on an http page (not localhost) Not Available on This Page. Generate Password ▸ with the four
  generator styles is added on password fields of secure pages while New Passwords is checked, and on every text input
  only with New Passwords in Any Text Field; generating needs no manager. The items sit below the editing commands
  because that is where macOS keeps fill commands in a text field's menu, and it keeps them apart from the system's
  own AutoFill ▸, which AppKit appends at the bottom. The page message travels on the frame's channel-associated
  `ACPageHost`, so it reaches the browser before Chrome's `ShowContextMenu`; native
  (`ArdiaWebView+VaultContextMenu.mm`) adds the items in its `+[NSMenu popUpContextMenu:withEvent:forView:]` hook
  (`…withFont:` too; the items are taken once per right-click, so a nested call adds nothing) and in
  `tab:runContextMenu:` for hidden instances, where `context-menu.json` gets them in the same place and a pick such as
  `Autofill › <login title> › Password` runs once JS has sent the list. JS (`state/vaults/contextFill.ts`) sends the
  options (`webView.setVaultContextMenu`: `autofill`, `generate`, `generateAnyField`) from the Suggest settings alone,
  so the hook is installed at launch, answers `vaultContext` with the list (`setVaultContextMenu`, metadata only), and a
  choice comes back as `vaultContextAction`. A fill is the usual `fillFromVault` with `target: "contextMenu"`: native
  always treats it as `userChose` (the URL match is skipped, never the https rule), never submits, still asks the owner
  check for a password, and marks the page message `context: true`, so the page script writes one value into the
  right-clicked input only (a code spreads over split boxes from the first box) or, for a whole login, fills the form
  around it. Generate Password on a password field fills every new-password field of that form, as a fill from the
  menu does, so a sign-up's confirm field gets it too; on any other input it writes that input only. Unlock Passwords… unlocks once and Other Passwords… opens the search, both as the fill menu under that
  field (top frame only, since only it has a rect); a pick there fills the classified field's login, or only the
  guessed value into a plain input. Generate fills through `fillGeneratedPassword` with the same target, so the
  generated password is still kept for saving. Until 2026-11-10 the options were sent as `autofill: false` and no
  generators whenever no manager was connected, so with every CLI signed out the hook was never installed, native
  dropped each `vaultContext`, and the menu showed none of these items.
- **Set Up Verification Code.** Right-clicking an image (an `img`, `canvas`, `svg`, `picture`, `object` or `embed`, or an
  element painted with a CSS background image, up to three parents up), an `otpauth://` link, a selected setup key
  ("Can't scan? Enter this key", base32 in one run or equal groups, with a digit or in capitals) or a read-only field
  holding one adds Set Up Verification Code ▸ to the context menu, once a manager that can store codes
  (`capabilities.addTotp`) is connected (`webView.setVaultCodeSetup`). The page script posts `vaultCodeTarget`
  (`{image, rect, viewport}` or `{text, rect}`; no rect in a frame); no image bytes travel through JS. Native
  (`ArdiaWebView+VaultCodeSetup.mm`) copies the page's rendered surface (`copyPicture`, so a cross-origin image is
  read too), crops to the element's rect plus 15% (the whole picture in a frame) and hands it to `VaultTotpSetup`,
  which runs Vision (`VNDetectBarcodesRequest`, QR only) off the main thread and keeps the code
  only when exactly one distinct `otpauth://totp/` URI that `VaultTotpSecret` accepts is found. A plain key becomes
  `otpauth://totp/<site>?secret=<key>&issuer=<site>`. Reading starts on the right-click, before the menu opens: the
  item shows Reading Code… while it runs and is hidden if nothing valid was found. The URI stays native under a
  random token for 10 minutes (at most 8); JS gets `vaultCode` `{token, issuer, account, rect}` and answers with
  `setVaultCodeMenu` (`state/vaults/totpSetupModel.ts`): a disabled header (`GitHub: octo`), the site's logins in
  managers that can store codes (the fill menu's ranking, the QR's account first, `(Has Code)` on one that has one),
  then Unlock Passwords… or Other Logins…, which opens the search under the image in pick mode
  (`menuPicks.ts`: a pick stores the code instead of filling). A choice comes back as `vaultCodeAction`. A login
  with a code asks "Replace the verification code for octo?" first. `vaults.addTotp` resolves the token, requires
  the owner check ("add a verification code"), and calls `VaultProvider.addTotp(cli, id:, uri:)` (the default throws
  `unsupported`, and a provider without `capabilities.addTotp` isn't offered). A provider writes the secret on stdin,
  never on argv, and checks the item it gets back holds it. On success the broker updates the item (`hasTotp`, the new `updatedAt`) and `cachedTotps`,
  persists the store, announces `itemsChanged`, refetches in the background and pins the URI to the refetched
  `updatedAt`, so the fill menu's code rows and local generation work at once; the tab shows "Verification code
  added to octo". In a hidden instance `context-menu.json` lists the item and a pick such as
  `Set Up Verification Code › octo · github.com` waits for the code and the list.
- **Editing logins.** `vaults.edit` (Settings › Profiles › <profile> › Passwords) and the save popover's Update go through
  `VaultBroker.edit(provider:id:change:)` with a `VaultLoginChange` (`VaultLoginEdit.swift`): nil fields stay as they
  are, `url` replaces the login's first (primary) URL and keeps the others, `totp` is unchanged, set (a URI
  `VaultTotpURI.setupURI` accepts) or removed. A change is refused as `invalid` when it's empty, a username is over 1,024
  characters, a password is empty, over 4,096 characters or holds a line break, or the URL isn't an http(s) URL. The
  broker checks the capability (`capabilities.edit`), that the manager is ready and the item is
  in a fresh list, asks the owner check ("change your password" when the password changes, else "edit a login"; never
  a Touch ID fill grant) and runs `VaultProvider.edit` in the manager's lane after any list fetch in flight (the
  default throws `unsupported`). A provider reads the item, changes only the fields in the change so unknown fields
  pass through as read, writes it back with the secrets on stdin, and checks the result holds every new value; the
  broker answers with a `VaultEditResult`. On success the broker updates the cached item (username, URLs,
  `hasTotp`, a new `updatedAt`), pins the new password and code to that `updatedAt`, drops the site index and recent
  codes, persists, announces `itemsChanged`, then refetches and pins again to the real `updatedAt`. A failed edit
  forgets the item's cached password (and code, when it changed), so the next fill reads the manager.
- **Updating a changed password.** A new-password submission (`newPassword` or `generated`) for a username saved at the
  subdomain tier or better in an unlocked manager that can edit (or in Ardia) shows the save popover as Update
  Password? with an Update button (`decideUpdate` in `saveOffer.ts`; the login used last on the site wins a tie). The
  username is the form's, else the site's only saved username (`soleSiteUsername`); with two accounts and no username
  on the page it offers nothing. The password field is the usual draft. Update calls the web view's
  `updateVaultPassword({provider, id, origin})`, which takes the captured password natively, checks the item matches
  the page's origin, and calls `VaultBroker.updatePassword` (an edit with only `password`); for an Ardia login it
  asks the owner check, calls `ArdiaVaultStore.update(login, password:)` and `ArdiaVaultBackup.noteChange()`. Chrome's
  own update prompt is hidden only while this popover handles the login; a login in a manager that can't edit keeps
  Chrome's prompt and gets no offer. `usage_counts` carries `vault_passwords_updated_from_offer` and
  `vault_logins_edited_manager` (edits of a provider's login from Settings or the popover).
- **Remembered logins.** The login last filled or saved per site (registrable domain) is kept as its item key in
  `vault-accounts.json` (at most 500, least recently used dropped) and is ranked first and selected when the menu opens.
- **The search menu.** Other Passwords… turns the menu into a search with its own field. It closes like the matches
  menu once neither the page field nor its search field has focus (after the same 100 ms grace, and not while the
  pointer is over it), and Escape from the page closes it; Escape in its search field goes back to the matches.
- **The menu over time.** Its rows are recomputed only when what they depend on changes (the field, mode, query,
  the managers and their lists, the Suggest settings), not on each hover or arrow key. The highlight follows the row, not
  its index: the menu keeps the highlighted row's key (`selectedKey`), and whenever its rows change under it (a manager
  locks, unlocks or relists, a passkey request arrives, a pending code expires) the highlight moves to the same row at
  its new place, or to the resting row when that row is gone (an Unlock row once its manager locked). The menu draws
  the same cached rows the keyboard and Touch ID act on (`rowsOfMenu`), and Return and a Touch ID grant re-check the
  highlight first, so they always act on the row the menu shows. A list asked for again while one is loading is fetched once
  more after it lands, and a list that lands after its manager locked is dropped. Closing a tab forgets its field, menu
  and page state. Opening and closing scale and fade over 160 and 120 ms; with Reduce Motion both only fade. Code
  rings sweep on the native driver at the display's rate. Rows are built once per change of their inputs (a small
  cache keyed by the store's lists, so opening, resting the highlight and rendering share one ranking), the rows past
  the visible seven mount a frame after the menu opens, a row re-renders only when its own props change, and a row's
  highlighted text layer exists only while it is selected or fading. A code field opens at once, with no wait for its
  codes; each code row shows its placeholder at the same size until the code arrives. A login row's second line is the
  host of the login's URL on the page's site (the page's own host when the login has it), so subdomain logins read
  apart.

## Ardia as a manager

Ardia's own store is a manager like the others (`ArdiaVaultIndex`), so a person who uses only Ardia gets the fill menu,
Other Passwords…, right-click Autofill, generators, auto-save and the save popover, Generated Passwords' Save, codes
and code setup from a QR code.

- **Not a CLI.** `VaultProvider` is CLI-shaped (`binaryName`, `VaultCLI`), so Ardia isn't in `VaultRegistry`. Instead
  each broker entry point starts with `if id == ArdiaVault.id` and hands the call to `ArdiaVaultIndex`: `providers`,
  `refresh`, `items`, `lock`, `signOut`, `configure`, `signIn`, `unlock`, `cancelSignIn`, `copy`, `totp`,
  `fillValues`, `save` and `export`; `addTotp` and `removeTotp` go to `VaultArdiaCodes`. Nothing that loops over `VaultRegistry.providers` (lock, sync, the
  store, iCloud) sees it.
- **State.** Always `unlocked` while any loaded profile is on Ardia with Save and fill passwords on (or no profile is loaded yet),
  else `unavailable` ("Off"), which isn't connected, so nothing offers it. The choice, Save and fill passwords and Import refresh it
  (`refresh` drops the list).
- **Logins.** The list comes from `passwords.list` (origin and username, no secrets) for every loaded profile on Ardia
  with Save and fill passwords on. `ArdiaVaultIndex` builds it once off the main thread (prewarmed at launch, about 100 ms for 10,000
  logins), keeps an id → item map and the serialized JSON, and answers `vaults.items` from memory (about 1 ms native
  for 10,000). Saves, renames and removals through `passwords.*` and Ardia's own save update it in place; a list older
  than 2 minutes, a choice or switch change, or Import is rebuilt in the background while the old one is served, so a fill or a
  menu never waits on it. Only an unknown item id waits for one rebuild (at most every 2 s). An item's id is the base64url of `profile\norigin\nusername`, its `profile` is the
  base engine profile, `urls` is the origin, `hasTotp` is whether a code is kept for it. JS shows a tab only the Ardia
  logins of its own profile (`itemsForTab`: the fill menu, right-click Autofill, code setup, the command bar and the
  save checks); Settings keeps Ardia out of the manager rows and out of the merged Saved Passwords list, which already
  has Chrome's.
- **Fill and copy.** The page passes its base profile (`ArdiaHost.baseProfile(of:)`); a login of another profile, or a
  profile off Ardia or with Save and fill passwords off, is refused. The origin, `userChose` and owner check rules are the broker's. The
  password is read natively for that one fill or copy with `ac_passwords_logins` (Chrome's store, no second prompt)
  and matched by realm and username; where that call isn't available it falls back to `passwords.reveal`, which asks
  Chrome's own reauth. No engine change was needed.
- **Saving.** `save` goes through `ArdiaServices.savePassword` into the tab's profile (Generated Passwords: the profile
  Settings shows), so Save new logins to can pick Ardia. When the vault flow claims a submission, Chrome's own save
  prompt is hidden as for any manager (`vaultClaimsPasswordPrompt`).
- **Codes, like Apple's Passwords.** Settings › Profiles › <profile> › Passwords' sheet for an Ardia login has a Verification Code row
  (`components/vaults/VaultCodeRows.tsx`, `state/vaults/ardiaCodes.ts`). Without a code it offers Set Up… with Paste
  Setup Key (native reads the clipboard: a key or an `otpauth://`/`steam://` link), Choose QR Code Image… (an open
  panel; a hidden instance reads `<data dir>/Verification Code.png`) and Scan QR Code on <site> (only when the front
  tab is that site: native copies the tab's picture and reads every QR on it). All three go through
  `vaults.readCode` `{source, origin, tabId?}`, which answers `{token, issuer, account}` or `{error: none | many |
  declined | unreadable}`; the secret stays native under the token and `vaults.addTotp` stores it after the owner
  check. With a code the row shows it live: the digits change on a timer set to the period's end, the ring runs on
  the native driver at the display's rate and stops while Ardia isn't active, and Copy Code copies it. In Edit,
  Remove asks first, then `vaults.removeTotp` asks the owner check. Adding or removing a code never uses a Touch ID
  fill grant. Renaming a saved password moves its code and deleting it drops the code (`vaults.ardiaLoginChanged`).
  Import Passwords… also stores codes from the CSV's `otpauth`, `totp`, `login_totp`, `otp` or similar column for
  the logins it saved (`vaults.importCodes` reads the file natively, so no secret passes through JS). A login
  without a code takes the imported one; replacing a different code asks the owner check once, and declining keeps
  the existing codes. Rows with a code and no matching login (an authenticator's export, or a site with no saved
  login) become standalone codes, named by the file's name or title column, else the link's account or issuer, else
  the site; a code already saved (on a login or alone) is skipped. Export Passwords… is Chrome's CSV and leaves every
  code out, standalone ones too, on purpose: a CSV is plain text, and a second factor kept next to its password in a
  file defeats it. Codes leave a Mac only sealed, through the iCloud backup.
- **Code after the password.** When a login with a known code fills a password, a click or key in a code field
  on that same origin and tab within 3 minutes fills the code, once (`startCodeAutofill` in `state/vaults/fill.ts`): only when
  exactly one such code is pending, the menu opened from that click or key (`onDemand`; a focus the page makes by
  itself fills nothing), the menu is in its list, and nothing is busy. The fill keeps the origin check. It works offline since Ardia's codes are made here.
  A code is only remembered after a login fill whose site matches the login at a tier that fills without a pick
  (`fillsWithoutChoice`, same or subdomain); a login picked by hand on a site it doesn't match (a look-alike page) arms
  nothing, and its code stays in the menu for an explicit pick.
- **Codes.** `addTotp` (right-click code setup) keeps the `otpauth://` URI in Ardia's sealed file
  `Password Managers/Cache/ardia.vault` (the store's key, `codes` keyed by the item id) after the owner check; codes are
  made on the Mac and the login gets code rows. With Sync with iCloud on they reach the owner's other Macs through the
  same merge, so a code set up on one Mac fills on the next (for the same profile id; the default profile is shared).
- **Export.** `export` with `provider: "ardia"` is Chrome's export for that profile to the file picked in the save panel
  (a hidden instance writes `<data dir>/Ardia Passwords.csv`).
### Choosing Ardia

There is no global switch. Each profile picks its password manager in Settings › Profiles › <profile> › Password
manager (`ardia | none | plugin:<name>`, `state/site/passwordManager.ts`; profiles sharing browser data share one
choice, private windows follow their profile). The engine in this document runs only for profiles on **Ardia**:
`vaultsOnForProfile(profileId)`, `vaultsOnForTab(tabId)` and `anyProfileOnArdia()` in `state/vaults/enabled.ts` gate
everything below. Credential providers are not separate choices: they are sources inside Ardia's fill menu,
connected once for the whole app, and the Password manager row names what an Ardia profile fills from (its saved
passwords and each connected provider by name).

| Choice | Fill UI | Key on the field | Save | Chrome's dropdown | Passkey wrapper |
| --- | --- | --- | --- | --- | --- |
| Ardia, with a source (Save and fill passwords on, or a CLI manager connected) | Ardia's fill menu | yes, opens the fill menu | Ardia's save popover | claimed by the menu | on |
| Ardia, no source | Chrome's dropdown | no | Chrome's | as Chrome | off |
| A `fill: "system"` plugin | macOS Passwords panel | yes, opens the panel | off (`password-manager.json`) | as Chrome | off |
| None | Chrome's dropdown | no | off | not claimed | off |

- **Leaving Ardia asks for the owner.** Picking None or a plugin for a profile on Ardia asks for the Mac owner first
  (`choosePasswordManagerChecked`, the same `ownerConfirms` as the lock settings). Declined, the choice stays Ardia
  and the row says "Confirm it's you to change this setting." for a few seconds. Picking Ardia never asks.
- **Connecting a manager pins Ardia.** A successful sign-in or unlock of a CLI manager records an explicit `ardia`
  choice for the profile it was connected from (and the profiles sharing its data) when that profile had never
  chosen, so turning on a built-in password manager plugin later never moves it. An explicit plugin or None choice
  is never overwritten.
- **Linux and Windows.** The engine is Mac only (`vaultsSupported` = `PLATFORM_FEATURES.systemPasswordManagers`).
  Elsewhere `startVaults` starts nothing, address and card fields open no menu, and the Passwords sub-page shows
  Import, Export, the help row, the saved list (no New Password, generated passwords, passkeys or codes) and the
  inline edit sheet over Chrome's store.
- **A profile off Ardia:** no fill menu from this engine (`noteVaultField` ignores its fields unless its plugin shows
  the key), no save or update offers or auto-save, no suggestions, code setup or code autofill, no command bar
  password commands, no Touch ID arming and no read-ahead. Its tabs never claim Chrome's dropdowns. Connected
  managers stay connected for the profiles still on Ardia; nothing is deleted, and iCloud sync and backup keep running.
- **Ardia with Save and fill passwords off** (Chrome's `credentials_enable_service`): Chrome's login dropdown is
  claimed in that profile's tabs whatever logins it holds, so none of Ardia's logins are offered.
- **No fill on page load.** Ardia launches Chrome with the `fill-on-account-select` feature for every profile, in every
  build (`ArdiaHost+Launch.mm`), so Chrome never fills a saved login when a page loads: the person fills through
  Ardia's menu, the field key or Touch ID, as in Safari. That also closes silent fills into invisible forms. The
  feature is launch-wide, so profiles on a plugin or None get it too. The engine patch adds
  `g_ardia_password_filling_allowed(WebContents*)` in `ChromePasswordManagerClient::IsFillingEnabled`, answered false
  when a tab claims every login (`ac_autofill_suppress.mm`), so Chrome's filling and suggestions stop at the source too.
- **Telemetry.** `password_manager_chose_<ardia|none|plugin>` counts the choice, `vault_guard_confirmed` and
  `vault_guard_declined` the owner check, and the daily `password_manager_profiles_<ardia|none|plugin>` the spread.

### Chrome's dropdown

Chrome's own autofill dropdown is a separate views window (`NativeWidgetMacNSWindow`) parented to the browser window,
so it always draws over the fill menu, which lives inside the window. It must never be on screen with the fill menu.

- **Claims.** Each tab holds a set of claimed kinds (`state/vaults/chromeDropdown.ts`,
  `claimChromeDropdowns(tabId, source, kinds, logins)`; claims from different sources are unioned, `[]` releases one).
  The fill menu claims `login` and `history` while it is open, with the usernames of its login rows
  (`state/vaults/menuDropdown.ts`), and re-claims when its rows change. A `login` claim covers a Chrome dropdown only
  when every saved login in it (`kPasswordEntry`, `kAccountStoragePasswordEntry`, matched by username) is one of those
  rows, so Chrome's dropdown is never hidden while it offers a login Ardia's menu doesn't show. Address and card fill can claim
  `address` and `card` the same way once Ardia's menu fills them; until then Chrome's address and card dropdowns stay.
- **Kinds.** Native sorts each suggestion Chrome reports (`tab:didShowAutofillSuggestions:`) by its type:
  `*Webauthn*`/`*Passkey*` is `passkey`, any other `*Password*` type is `login`, `kAutocompleteEntry` (form history) is `history`, `*CreditCard*`/`*Iban*` is `card`,
  `*Address*` is `address`, `kUndoOrClear` and separators don't count, and anything else (a site's datalist) is
  `other`, which is never claimed.
- **Closing it.** When every kind in a dropdown is claimed, `ArdiaWebView+ContextMenu.mm` closes it on the spot: an
  Escape sent straight to the page's `RenderWidgetHostViewCocoa`, only while Chrome's dropdown window is on screen and
  once per dropdown window. Chrome's dropdown controller takes the key, so the page never sees it. Claims live natively by the
  app's tab id, so a claim made before the page exists holds. A claim also closes a
  claimed dropdown already on screen (`vaults.claimChromeDropdowns` answers `{hidden, showing}`), which covers Chrome's
  dropdown opening on focus before the menu.
- **Who gives way.** With `other` in Chrome's dropdown, or a saved login the menu doesn't show, the menu closes for it
  (unless it is busy), and a missed login refreshes Ardia's index (`vaults.refresh`). This is what happened with Save and
  fill passwords off while another manager was locked: that switch is Chrome's `credentials_enable_service`, which stops offering to save but not Chrome's own fill, so Chrome kept offering the
  saved login while Ardia's menu had only Unlock. Login and history dropdowns the menu covers close for it, even when
  its only other row is Unlock. Siblings (a login for `home.example.com` on `server.example.com`) are login rows
  labelled with their host, filled only when picked. An address or card dropdown closes when the
  menu has a fill row, was asked for or is busy; otherwise the menu closes for it.
- **Engine hook (written, not yet built).** `engine/ardiacore/apply.sh` adds
  `g_ardia_autofill_suggestions_suppressed(WebContents*, span<const Suggestion>)` at the top of
  `AutofillPopupControllerImpl::Show` (root popups only), which hides the popup before it is created when it answers
  true. ArdiaCore answers from the same kinds and usernames (`ac_autofill_suppress.mm`,
  `ArdiaCoreTab.suppressedAutofillKinds` and `suppressedAutofillLogins`), which
  `claimChromeDropdowns` sets when the framework has it. With it, Chrome's dropdown never draws at all and the Escape
  path goes idle.
- **Telemetry.** `vault_chrome_dropdowns_hidden` counts dropdowns closed; `vault_menu_yields_to_chrome` counts menus
  that gave way. After the engine hook ships, hidden counts should drop to near zero.

### Ardia backup

With Sync with iCloud on, `ArdiaVaultBackup` keeps every Ardia login (site, username, password) of every loaded,
non-private profile, plus its code, in `ardia.vault`, sealed with the synced key, so only the owner's Macs can read the
copy in iCloud Drive. Passwords are read natively (`ac_passwords_logins`), never through JS, and nothing is written in
the clear.

- **Format.** `ardia.vault` is `{version: 4, codes, logins, standalone}`, each a `VaultLedger`: per key the value (or a
  tombstone for a removal), a stamp and the Mac's random id. `standalone` (version 4) holds codes saved on their own,
  keyed `code.<uuid>`, each value a sorted-keys JSON `{uri, label, issuer?, website?, createdAt?}`, so a rename or a
  website change is one entry write and two Macs editing the same code resolve by stamp like any other key. A version
  3 file opens with an empty `standalone` and is written back as 4; a Mac on the previous version reads a version 4
  file (it ignores `standalone`) and, if it pushes, drops only its own copy of them: the newer Macs keep theirs and push
  them back, since a merge never removes what a ledger doesn't mention. An entry this version can't read is never
  treated as deleted. The stamp is a hybrid clock (the wall clock in ms, but always past
  the stamp it replaces), so an edit made after seeing another always wins, and two edits made apart win by time.
  Merging takes the higher stamp per key and is the same in either order. A version 2 file's codes migrate in.
- **This Mac's view.** The local file also keeps (never in iCloud) a SHA-256 fingerprint of each password this Mac has
  seen in its own store. A login new here is added; a password changed here since it was seen replaces the backup's; a
  login this Mac never saw never replaces the backup's (an older copy restored on a reinstall can't undo a newer
  change); a login seen and now gone becomes a tombstone. A profile that couldn't be read removes nothing, and when more
  than 3 and over half of a profile's seen logins vanish at once the store is treated as wiped: nothing is removed and
  Restore offers them back.
- **When.** 3 s after a login is saved, changed or removed (Ardia's save, Settings, the list changing) or a code is
  added or removed, on Sync Now, when Sync with iCloud turns on, and when Ardia becomes active or the screen unlocks if
  the last backup is a day old. Never while the screen is locked; no timer runs. Offline it merges locally and iCloud
  Drive uploads later.
- **Standalone codes.** They live only in `ardia.vault`, so they need no Restore: the merge that runs when the store
  opens, on Sync and on every iCloud change brings them back on a new Mac or after a reinstall, and a deletion's
  tombstone keeps them deleted. Turning Sync with iCloud off keeps them on this Mac (like login codes). Adding,
  renaming or deleting one writes the local file at once and pushes 2 s later, so nothing waits on iCloud.
- **Restore.** Settings › Profiles › <profile> › Passwords › Restore from iCloud appears when the backup has logins this Mac's store lacks.
  After the owner check it saves each missing login with `ArdiaServices.savePassword` into the profile with the same
  engine id, else the default profile, moving its code along. It never replaces a login this Mac already has, offers
  one copy per site and username, and doesn't offer a login removed on this Mac.
- **Update.** Update N Passwords from iCloud appears when a login's password was changed on another Mac after the copy
  this Mac has: the Mac keeps, per login, the ledger stamp of the copy it last matched, and the backup's copy must
  carry a later stamp while this Mac's password is unchanged since (never decided by clock alone). After the owner
  check it updates each with `ArdiaServices.updatePassword` (`vaults.updateFromBackup`).
- **Status.** The Sync with iCloud row says `Backed up 5 min ago`, `Not backed up yet`, `Waiting for iCloud Keychain`
  (the backup is sealed with a key this Mac doesn't have yet; nothing is overwritten), `Waiting for iCloud Drive`, `Update Ardia to keep syncing` (a newer Ardia wrote the backup; this Mac only reads it), or a
  one-line error. Counts for the row (`restorable`, `updatable`) come from the login list and the stored fingerprints,
  never from reading this Mac's passwords. Calls: `vaults.backupStatus {profiles}` (with `restorable`), `vaults.restoreBackup {profiles}`
  (`{restored, failed, declined}`), event `vaults.backupChanged` (with `outcome` for telemetry), and `backup` in
  `vaults.sync` and `vaults.syncStatus`.
- **Telemetry.** `usage_counts`: `vault_logins_created_settings`, `vault_logins_created_with_code`,
  `vault_logins_edited_ardia`, `vault_codes_standalone_created`, `vault_codes_standalone_imported`,
  `vault_codes_standalone_deleted`, `vault_codes_standalone_copied`, `vault_codes_standalone_filled`. Watch created
  against deleted on the dashboard, and filled against created: a code that never fills means its website is wrong.
  `vault_backups`, `vault_backup_failures`, `vault_backup_key_waits`,
  `vault_backup_deletes`, `vault_updates_from_backup`, `vault_restores`,
  `vault_restores_declined`, `vault_logins_restored`, `vault_logins_restore_failed`.

## Passkeys

Ardia is a WebAuthn authenticator of its own, the way password-manager extensions are, with no engine change: the page
script wraps `navigator.credentials` and native Swift does every bit of crypto. Chrome's own WebAuthn (security keys,
a phone by QR code, Chrome's Touch ID passkeys) stays one click away as Other Options…, and handles everything Ardia
doesn't.

| File | Role |
| --- | --- |
| `page_script.js`, the block that starts `const passkeysOn = true;` | The wrapper (top frame only). |
| `VaultPasskeys.swift` | The coordinator on the main actor: page messages, pending requests, the owner check, signing, answers, events. |
| `VaultWebAuthn.swift` | Canonical CBOR, base64url, `clientDataJSON`, authenticator data, `none` attestation, ES256 signatures, the rpId check (`VaultRelyingParty`). |
| `VaultPasskey.swift` | The stored passkey, request parsing (`VaultPasskeyRequest`), candidates and signers. |
| `VaultBroker+Passkeys.swift` | `VaultPasskeyHolder`, the protocol a provider that keeps passkeys conforms to, and the broker's calls into it. |
| `VaultSystemPasskeys.swift` | The system route (iCloud Keychain and other apps), live only with Apple's entitlement. |
| `ArdiaWebView+VaultPageMessages.mm` | Routes `passkey*` messages, answers frames, checks the tab's committed origin and certificate, rewrites the page script for the switch. |
| `state/vaults/passkeys.ts`, `passkeyStore.ts`, `components/vaults/VaultPasskeySheet.tsx`, `VaultPasskeys.tsx` | The sheets, the fill menu rows, Settings. |

### What a page sees

- **The wrapper.** Installed only in the top frame (`window === window.top`) and only when the page script's
  `passkeysOn` constant is true. `CredentialsContainer.prototype.create` and `get` (captured from
  `navigator.credentials`'s prototype at install, before page scripts run) become Proxy-disguised functions;
  `PublicKeyCredential.isConditionalMediationAvailable` and `isUserVerifyingPlatformAuthenticatorAvailable` answer
  true. `PublicKeyCredential` itself doesn't exist yet when the page script installs (Chromium adds secure-context
  interfaces after the script context is created), so the statics are wrapped a microtask later, and results are
  built on the real prototypes once they exist. Calls without `publicKey`, with `password`/`federated`/`identity`/
  `otp`, on another receiver, with an already aborted signal, a mediation other than none, `optional`, `required` or
  (for get) `conditional`, options that don't serialize, or a message over 60 KB go straight to Chrome.
- **The answer.** A `PublicKeyCredential`-shaped object on the real prototype with own properties shadowing the
  native getters: `id`, `rawId`, `type`, `authenticatorAttachment: "platform"`, `response` (`clientDataJSON`,
  `attestationObject`, `getTransports()` = `["internal"]`, `getAuthenticatorData()`, `getPublicKey()` (SPKI),
  `getPublicKeyAlgorithm()` = −7; or `authenticatorData`, `signature`, `userHandle`), `getClientExtensionResults()`
  (`credProps` and `appid` only when asked) and `toJSON()` in Chrome's shape.
- **Fallback.** Native answers `fallback` and the wrapper calls Chrome's original with the page's own options object and
  signal. With no acknowledgement within 3 s (a tab with no web view, an old build) it falls back on its own. After the
  acknowledgement a modal request is rejected with NotAllowedError at its timeout plus 30 s if native never answers.
- **Errors.** Not Now, Cancel and the close button reject with NotAllowedError; OK on "Passkey Already Saved" (an
  `excludeCredentials` hit, shown only after the person answers) rejects with InvalidStateError; aborting rejects with
  the signal's reason and tells native; `pagehide` rejects what's pending with AbortError.

### Native rules

- **Origin.** Only the browser's committed origin of the frame (`RenderFrameHost::GetLastCommittedOrigin`), only for the
  primary main frame (`IsInPrimaryMainFrame`: iframes, fenced frames and prerenders fall back), only `https://` or exactly
  `http://localhost[:port]`, and only while the tab's security level is `secure` (a certificate error, mixed content or
  a pending navigation to another origin falls back). A credential answer is delivered only if that still holds at that
  moment and the frame is the one that asked; fallback and error answers carry nothing and always go out, so no page
  promise is left hanging.
- **rpId.** Lowercase LDH only, no IP address, no trailing dot or empty label, at most 253 characters; equal to the
  origin's host or a parent of it that isn't a public suffix (the full PSL, private section included: `github.io`,
  `vercel.app`); a host that is itself a public suffix gets nothing. Anything else falls back and Chrome raises its
  SecurityError. Related origins (`/.well-known/webauthn`) fall back.
- **Algorithms.** ES256 only (an empty `pubKeyCredParams` means the defaults, which include it). RS256 or Ed25519 alone,
  `cross-platform` attachment, a `security-key` or `hybrid` first hint, and `enterprise` attestation fall back.
- **Bytes.** `clientDataJSON` is `{"type","challenge","origin","crossOrigin":false}` with the spec's CCDToString escaping.
  Authenticator data: SHA-256 of the rpId, flags UP | UV | BE, plus BS while Sync with iCloud is on (always for a provider's passkey),
  AT on create, sign count 0, a zero AAGUID, a 16-byte random credential id and a canonical COSE EC2 key. Attestation is
  `none` (`{"fmt","attStmt","authData"}` in canonical order). Assertions are ECDSA P-256 over authData ‖
  SHA-256(clientDataJSON), DER. `packages/ardiacore/tests/vault-passkeys.test.swift` checks CBOR heads and key order,
  known rpId hashes (`example.com` → `a379a6f6…`), the layout, that the COSE key is the public key, that signatures verify
  and fail on a changed flag or origin, the rpId table, request parsing and storage.
- **Requests.** One modal request per tab; another while one is up, or a third within 60 s of two Not Nows in that tab,
  gets NotAllowedError with no sheet. A modal request needs the tab on screen in the key window (a hidden test instance
  skips the key-window part); a conditional one doesn't. A new conditional request replaces the tab's earlier one
  (AbortError), and a modal one cancels it (NotAllowedError). A request is registered the moment it arrives, so a cancel,
  a new document or the switch reaches it even while its passkeys are still being looked up. Modal requests end at the
  page's timeout, clamped to 10 s–10 min (5 min by default); conditional ones have none.
- **Every create and every use asks.** Touch ID, else the Mac password (`VaultOwnerCheck.confirmEach`), each time; the
  reason names the rpId ("save a passkey for webauthn.io"). A passkey use doesn't count toward the 30 s "recently
  confirmed" window, and nothing else counts for it. A touch on the fill menu's Touch ID view grants exactly
  `passkey\n<request>\n<credential>`, single use, 10 s.
- **Saving.** The new passkey is stored first, then the answer goes out; if the page has gone by then it's removed again.
  Only once the answer is out are older passkeys for the same rpId and user handle removed.
- **Storage.** A `passkeys` ledger in `ardia.vault` (file version 5): key = credential id, value = sorted-keys JSON with the
  rpId, user handle, user name, display name, the raw P-256 scalar, created-at and origin. It is sealed and merged across
  Macs exactly like standalone codes (iCloud Drive, tombstones, newest stamp wins), kept when Sync with iCloud is off, read
  on demand and dropped from memory on lock. Names lose control and format characters (bidi marks) before they're stored
  or shown. Passkeys aren't per profile: like Apple's, they belong to the Mac's owner. Private windows can use and save
  them; the save sheet says the passkey stays after the window closes.
- **Secrets.** Private keys never reach JS, events, logs or telemetry; JS sees id, rpId, user name, display name, created-at
  and the manager.

### Where a new passkey goes

A new passkey follows Save new logins to, the same target as logins (`preferredSaveTarget`; with one manager connected
that one is the default). Ardia can always hold one, and so can a provider that declares `capabilities.passkeys` and
conforms to `VaultPasskeyHolder` (`holdsPasskeys(provider)` in `state/vaults/passkeyTarget.ts`). No provider holds
passkeys yet:

- **A holder, unlocked:** the sheet says "Saves to <name>" with its badge, and Save writes it through the provider.
  Native generates the key (CryptoKit) and hands the provider a `VaultNewPasskey` through `savePasskey(cli, credential:,
  attachTo:, title:, url:)`, attached to a login for the same site and username when there is one, else as a new item
  named after the site. The secrets go on stdin, never argv, as for logins. The provider reads the item back and checks
  that the stored key signs as the new key before the page gets its answer.
- **A holder, locked:** "<name> is locked, so this passkey saves to Ardia. Unlock <name> to save it there."
- **A provider that isn't a holder:** "<name> can't keep passkeys saved from Ardia, so this one saves to Ardia."
- **A choice:** with more than one place, Save To picks between Ardia and the unlocked holders for this passkey.

The sheet never stores anywhere it hasn't named. If a provider's save fails, the sheet stays open with its message,
and the person can try again or switch to Ardia. If the page has gone by the time the provider answers, the passkey
stays in that manager (unlike Ardia's store, Ardia doesn't delete from a manager on its own). Signing with a
provider's passkey goes through `passkeySigner(cli, item:, credential:)`, which reads the key at signing time; the
provider drops it after use and never caches it.

### What the person sees

- **Save a Passkey for <site>?** (`VaultPasskeySheet`, top right like the save-password offer): the account and site in a
  well with the passkey tile, Other Options…, Not Now, Save. When the origin's host isn't the rpId it says "<site> for
  <rpId>". In a private window it says the passkey stays after the window closes.
- **Sign In to <site>?** lists the passkeys that apply (Ardia's and any holder's), each with the key tile and its
  manager's badge; with more than one, a radio column picks. Continue asks Touch ID.
- **Other Options…** hands the request to Chrome's own WebAuthn window (security key, phone, Chrome's Touch ID). With
  Apple's entitlement it is a menu: iCloud Keychain or Another App…, Security Key or Phone….
- **Autofill (conditional mediation).** When a page asks with `mediation: "conditional"` and passkeys apply, they're rows
  at the top of the fill menu on username fields whose `autocomplete` has `webauthn` ("Passkey for <site>"), resting on
  the first, with the Touch ID glyph; a touch, Return or a click signs in. No passkeys means Chrome's own conditional UI.
- **Settings › Profiles › <profile> › Passwords › Passkeys** (under Saved Passwords, searched with it): site and account per row; the sheet shows
  Username, Name, Website, Created and Saved In, with Delete (confirm, owner check) for Ardia's. A provider's passkey's
  sheet says to change it in that manager. An Ardia login's sheet shows a Passkey row when one exists for its site and
  username.
- **The switch.** With Password Manager off, native rewrites the page script with `passkeysOn = false`, so new documents
  aren't wrapped at all; documents already wrapped are answered with fallback, and pending requests fall back.

### Passkey extensions (Proton Pass, 1Password, Bitwarden and the rest)

Password-manager extensions do WebAuthn the same way Ardia does: a MAIN-world content script replaces
`navigator.credentials.create`/`get`. Ardia never fights them; Settings › Profiles › <profile> › Passwords › Use passkeys from decides who answers.

- **The ordering.** Ardia's page script installs when the script context is created, before anything else; an
  extension's MAIN-world script runs later, at `document_start`. Both Proton Pass (`webauthn.js`, read from 1.43.0) and
  Bitwarden (`fido2-page-script.ts`) first bind whatever `navigator.credentials.create/get` are (that is, Ardia's
  wrappers) as their fallback, then install their own by plain assignment on the `navigator.credentials` instance.
  Left alone, that assignment would put the extension in front of Ardia.
- **The trap.** Ardia's page script makes `create` and `get` on `CredentialsContainer.prototype` accessors. Assigning to
  the instance runs Ardia's setter instead of adding an own property, so the page keeps calling Ardia's wrapper first.
  The setter attributes the assignment from the frame that called it (a `chrome-extension://<id>/` frame directly below
  the setter, read with captured `RegExp.prototype.exec`; an extension higher up the stack, such as a hooked timer,
  doesn't count) and records that extension's function as a contender for that page. The first function an extension
  registers stays (extensions run at `document_start`, before the page's own scripts), so a page can't swap in its own
  under an extension's name; assigning back the bound original (`bound get`/`bound create`, Bitwarden's `destroy()`)
  leaves the list. An assignment with no extension frame (the page's own code) becomes an ordinary own property,
  exactly as natively. The setter never throws into the extension: on any failure it does the native thing. An extension that uses `Object.defineProperty` on the instance still lands in
  front of Ardia, as it would without Ardia; none of the ones checked does.
- **Routing.** Each request tells native which extensions are contenders on the page. A page can forge that stack (its
  own `Error.prepareStackTrace`), so the claim is only a hint: native keeps at most 8, once each, in installed order,
  and only extensions that are installed, enabled and passkey managers, either a known ID or one whose manifest has a
  MAIN-world content script that touches `navigator.credentials` (`VaultPasskeyExtensionScan`, read from the profile's
  `Extensions/<id>/<version>` folder off the main thread). A page therefore can't use Ardia to learn which unrelated
  extensions are installed, and the most a forged claim does is get the page's own function called. Native then decides
  (`VaultPasskeyRoute`, unit-tested):

  | Use passkeys from | Sign in or save (modal) | Autofill (conditional) |
  | --- | --- | --- |
  | Ask Each Time | the chooser: Ardia (when it has a passkey for the site, or to save), each extension, Security Key or Phone | Ardia's fill menu when Ardia has passkeys there, else as if Ardia weren't there |
  | Ardia | Ardia's sheet; with nothing to sign in with, the chooser without Ardia | Ardia's fill menu, else as if Ardia weren't there |
  | an extension | straight to it | straight to it |
  | Chrome (Security Key or Phone) | Chrome's own window | Chrome's own |

  With no contender on the page everything works as before. A default extension that's disabled or removed counts as
  Ask. Ardia's sheet's Other Options… also lists the page's extensions.
- **Handing off.** To route to an extension, the page script calls that extension's recorded function with the page's
  own options object. If the extension declines (Proton Pass when signed out), it calls its saved fallback, which is
  Ardia's wrapper: the wrapper recognises the handed-off options object (or its `publicKey`) and goes straight to Chrome,
  so nothing loops. The mark is cleared once the extension's promise settles, so a later retry is a new request, and a
  hand-off that throws rejects the page's promise instead of leaving it waiting. A modal request in a tab that can't
  show a sheet goes to Chrome when that's the choice, else as if Ardia weren't there. "As if Ardia weren't there" (Ardia can't take the request: an unsupported
  algorithm, a call that isn't WebAuthn, a page that isn't secure) means the extension that installed last, which is
  who would have answered without Ardia; "Chrome" means Chrome's own window even with extensions present.
- **Which extensions count.** Settings lists enabled extensions that are known passkey managers (the IDs of Proton Pass,
  1Password, Bitwarden, Dashlane, NordPass, Keeper and LastPass) or that native confirmed on a page (a claim that passed
  the manifest check above, remembered in `vaultPasskeyExtensions`, at most 64). Names drop the store tagline ("Proton Pass: Free
  Password Manager" shows as Proton Pass). The row appears only when at least one such extension is enabled.
- **Off.** With Password Manager off nothing is wrapped, so extensions behave exactly as in Chrome.
- **Verified** (2026-11-14) with the real Proton Pass 1.43.0 from the Chrome Web Store in a hidden instance with a scratch
  data dir, no Proton account, on webauthn.io. The setter's stack named `ghmbeldphafepmbegfdlkpapadhbakde/webauthn.js`.
  Ask showed the chooser with Proton Pass, and picking it handed the request to Proton. Proton as the default sent
  Proton's own `PASSKEY_CREATE` bridge message and, signed out, fell back to Chrome's window. Ardia showed Ardia's sheet,
  and Chrome showed Chrome's window, without Proton being called. Proton disabled while it was the default gave Ardia's
  sheet. Autofill stayed in Ardia's menu under Ask and Ardia, and went to Proton or Chrome under those. A signed-in
  Proton taking a passkey wasn't tried (no account).
- **Tests.** `passkey-page-script.test.mjs` runs fake extensions under `chrome-extension://` file names (recorded and
  attributed, no shadowing, routing to a named one, its fallback reaching Chrome once, a retry after it settles,
  a hand-off that throws, first registration wins, only the calling frame counts, as-if-absent picks the last one,
  calls Ardia doesn't take go to it, a bound restore and a page's own override); `vault-passkeys.test.swift` also checks
  the claim filter and the manifest scan (a MAIN-world wrapper, an isolated-world one, an unrelated one); `vault-passkeys.test.swift` covers the
  routing table; `state/vaults/passkeySources.test.mjs` covers which extensions count, the fallback to Ask, the options
  and names.
- **Telemetry.** `usage_counts.vault_passkeys_via_ardia`, `_via_chrome`, `_via_extension_<vendor>` (proton,
  onepassword, bitwarden, dashlane, nordpass, keeper, lastpass, other), and `vault_passkey_chooser_shown`. Watch the
  extension counts against the chooser: a chooser that's always answered with the same extension means people want it
  as the default.

### The system route (lights up with Apple's grant)

`VaultSystemPasskeys` uses `ASAuthorizationPlatformPublicKeyCredentialProvider` with `ASPublicKeyCredentialClientData`
(challenge, the verified origin, `crossOrigin = .sameOriginWithAncestors`), so macOS builds `clientDataJSON` with the true
origin and offers iCloud Keychain and every enabled credential provider app (System Settings › General › AutoFill &
Passwords). It is available only when `com.apple.developer.web-browser.public-key-credential` is in
the signature (`WebKitHub.passkeysEntitled`) and browser passkey access isn't denied; the sheets then offer iCloud
Keychain or Another App… under Other Options…. The same origin, rpId and certificate checks run first; a request that
ends (timeout, abort, navigation) cancels Apple's sheet; a registration's authenticator data and public key are read back
from the attestation object so `getPublicKey()` and `toJSON()` are complete. macOS has no system conditional UI for
browsers (`performAutoFillAssistedRequests` is unavailable on macOS), so system passkeys are offered from the sheet, not
the fill menu. Once the grant arrives, Chrome's own WebAuthn (Other Options…) also reaches iCloud Keychain, since it
checks the same entitlement at run time. Untested until then.

### Builds and testing

- Ad hoc and development builds work fully: the owner check is LocalAuthentication, no keychain access control is
  involved, and keys live in the sealed `ardia.vault` (which a hidden test instance keeps in its data dir).
- A hidden test instance answers the owner check from `ARDIA_TEST=reauth=granted`.
- `packages/ardiacore/tests/passkey-page-script.test.mjs` runs the wrapper in a fake page (wrapping only in the top frame
  and while on, the message shape, the credential's prototypes and `toJSON`, fallback, the ack timeout, the watchdog,
  error names, answers read from own properties only, abort and `pagehide`, the size limit, late `PublicKeyCredential`).
- Verified on webauthn.io in a hidden instance (2026-11-14): register, sign in from the sheet, and sign in from the fill
  menu's passkey row, each accepted by webauthn.io's server; Cancel → NotAllowedError; Other Options… → Chrome's window;
  the switch off leaves new pages unwrapped.

### Telemetry

`usage_counts`: `vault_passkeys_created`, `vault_passkeys_used`, `vault_passkeys_fallback` (handed to Chrome, chosen or
because nothing applied), `vault_passkeys_refused` (Not Now, Cancel, timed out), `vault_passkeys_failed`,
`vault_passkeys_deleted`. Watch used against created (a passkey that's never used means sign-in isn't finding it), and
fallback against created + used on the dashboard.

## The Passwords sub-page

Settings › Profiles › <profile> › Passwords. On a Mac profile on Ardia it shows, in order:

1. **For All Profiles** (`PasswordManagers.tsx`, `ForAllProfilesSection`): a row per registered provider (none until
   plugins register; Connect…, Unlock,
   and a ⋯ menu with Lock, Export Passwords… and Sign Out…) and Sync; then Suggest, Ask before filling, Translucent
   password menu, Offer to save new logins, Save new passwords automatically, Save new logins to, Use passkeys from,
   Lock after, Lock when screen locks, Lock when Ardia quits, Keep generated passwords and the iCloud rows. These are
   app-wide settings, shown on every Ardia profile's page.
2. **Passwords**: Import passwords (CSV; codes in the file are kept too), Export passwords (Chrome's CSV,
   `passwords.export`; `vaults.export` serves CLI managers only) and the Password manager apps help row.
3. **Saved Passwords**, the merged list below, with New Password on its header.
4. Generated Passwords, Passkeys and Verification Codes, each only when it has rows.
5. Never Saved.

Other profiles, and every profile on Linux and Windows, see the plain page: Passwords, the saved list and Never Saved.
Rows on the sub-page are not search anchors (search opens the profile, not its sub-pages); the profile rows' keywords
(`rows/profileRows.ts`) carry the password-manager keywords ("password manager", "passkeys", "verification codes" and the like), so those
searches land on Passwords.

## Saved Passwords

The sub-page lists Ardia's own saved passwords and the logins of every unlocked manager in one list, sorted by
site and searched together; a manager's login carries its badge. The list grows as you scroll
(`state/settings/growingRows.ts`, `useGrowingRows`): 100 rows mount first and each time the scroll nears the end the
next 100 join, so 10,000 logins mount one page until someone scrolls; passkeys and verification codes past 60 rows
grow the same way. Ardia's and the managers' halves are built and sorted separately and merged, a
search that extends the last one filters the last result, and the pane loads only the managers' lists (Ardia's comes
from Chrome's list). Changes that weaken the fill protections (Ask before filling off, Lock when screen locks or Lock
When Ardia Quits off, a longer Lock after) ask for the Mac owner first (`state/vaults/settingsGuard.ts`, Chrome's
re-auth, never the menu's Touch ID grant) and are dropped when declined. Those settings and Sync with iCloud are not
read from `~/.config/ardia/config.json`. Its sheet copies the username, and copies the
password through the broker (owner check first); a manager's password never reaches JS, so it isn't shown.

**New Password.** The + on the Saved Passwords header opens one sheet (`components/vaults/LoginFormSheet.tsx`) with
Password | Verification Code. Password: Website (a bare domain becomes `https://`; anything else that isn't https,
or http on localhost, is refused: `state/vaults/loginForm.ts`, checked again natively by
`ArdiaStandaloneCode.websiteOrigin`), Username, Password, Profile (only with several profiles) and Verification Code
(Set Up… with the login sheet's three methods). The password field is the native `ArdiaVaultPasswordField` on a
page-less draft (`vaults.newPasswordDraft`); the key button's menu fills it with one of the four generators natively
and shows it, and JS only learns its length. Save calls `vaults.createLogin`: with a code it asks the owner check
first, then saves through `ArdiaServices.savePassword` into that profile's Chrome store, adds the login to the index in
place, keeps the code in `ardia.vault` and schedules the backup. The same site and username already saved shows "A
password for this username is already saved." with Show Password. Verification Code: Code (Set Up…; with no website
Scan QR Code reads the front tab whatever its site, and a pasted bare key is kept with no name), Label (filled from
the link's account, else issuer), Issuer and Website (both optional); Save calls `vaults.addCode`, which asks the owner
check. Return saves from any field, Esc cancels, Tab and Shift-Tab walk the fields (the password field's `tabs`).

**Edit.** Edit on any login opens the same sheet. An Ardia login (`vaults.edit` with `provider: "ardia"`,
`VaultArdiaLogins.edit`): a new username is Chrome's update; a new website saves the login there and removes the old
one; the password field starts empty ("Unchanged") and replaces the password only when typed or generated; the code
can be replaced or removed. A changed password or code asks the owner check first. The code follows a rename or a
move, the index updates in place and the backup runs 3 s later. A manager's login goes through `VaultBroker.edit`
(Editing logins above); a provider without `capabilities.edit` has no Edit in its sheet.

**Verification Codes.** Below the passwords, a section lists the standalone codes (only when there is one, sorted by
label, searched with the same field by label, issuer and website). Each row shows the label, the issuer or site, the
live code with the sheet's countdown ring and a copy button; up to 60 rows insert and leave with `Expand`, more
grow as you scroll. A row opens a sheet with the live code, Label, Website and Delete (a confirm, then the owner check). Live
codes read once per period and stop while Ardia isn't active. On a code field the fill menu offers a code whose
website matches at the subdomain tier or better (`menuModel.ts`, `codes` input; siblings only from search); a code
with no website appears only in Other Passwords… on a code field, and never on a password or username field. The
fill natively checks the https rule and the site match (`userChose` skips only the match).

Above it, Generated Passwords lists the kept generated passwords, newest first, with the site, the username if one was
captured, and when it was generated. Each row has Fill (when the focused window's active tab last focused a login
field on that site; the click counts as the person's choice, so a password made on `signup.example.com` fills on
`login.example.com`), Copy Password (owner check, concealed clipboard), Save to… (always a menu of every unlocked
manager that can save, Ardia included, with the default first and checked: Save new logins to, else the one connected
CLI manager, else Ardia; Ardia saves into the profile Settings shows; without a username a sheet asks for one with the
same suggestions), and Delete.

The engine side of this (autofill menu fill and key routing, and Chrome dropdown suppression at the source) is kept unapplied in `docs/engine-pending/password-autofill-menu.patch`, so `engine/` matches a prebuilt engine and `build-app` keeps fetching it. To land it: apply the patch with `git apply`, build the engine (`docs/engine-build.md`), and commit both together.
