# Import from a password manager (credential exchange)

macOS 26 lets a password manager hand its passwords, verification codes and passkeys straight to another app, with
no file in between: the Credential Exchange Format (CXF) through `ASCredentialImportManager`. Issue #3429.

## How it works

1. The user starts the export in the other app (Passwords, or a password manager that exports to apps) and picks
   Ardia in the system sheet. Ardia can't start an import itself: there is no API to ask for one.
2. macOS opens Ardia with an `NSUserActivity` of type `ASCredentialExchangeActivity` whose `userInfo` holds
   `ASCredentialImportToken`. `AppDelegate.swift` passes it to `CredentialExchangeInbox` (`packages/import/ios`).
3. The `ArdiaCredentialExchange` module (`CredentialExchangeModule.swift`) tells JS, which calls `take`:
   `ASCredentialImportManager().importCredentials(token:)` returns `ASExportedCredentialData`, and
   `CredentialExchange.summarize` (`ios/Core/CredentialExchange.swift`, tested by `swift test`) turns it into logins
   (every http(s) website of an item × its basic-auth credentials), codes (TOTP as `otpauth://totp/…` with the secret
   in base32, its algorithm, digits and period) and counts: passkeys, items with no website, other items.
4. JS (`apps/browser/src/state/import/credentialExchange.ts`) opens the import window, saves the passwords into the
   window's chosen profile (the engine's batch save when `ArdiaPasswords.saveMany` exists, else `savePassword` 8 at a
   time) and the codes with `saveVerificationSecret`, and shows the done step with what came over. Settings ›
   Passwords shows the same summary.

Passkeys stay behind: Chrome's Mac passkey stores are the Secure Enclave (Touch ID), iCloud Keychain (Apple's
browser entitlement, not granted) and Google Password Manager (a Google account), and none takes an outside private
key. Importing them needs a new engine authenticator whose keys are wrapped by Ardia's own key.

## Turning it on (needs the owner)

macOS offers an app as an export target only if the app carries an AutoFill credential provider extension whose
`ASCredentialProviderExtensionCapabilities` has `SupportsCredentialExchange` and `SupportedCredentialExchangeVersions`.
The extension is written and kept out of the build until Apple's side is done:

- `apps/browser/macos/ArdiaCredentials/`: `Info.plist` (exchange only; it provides no passwords, passkeys or codes to
  AutoFill), `ArdiaCredentials.entitlements` (`com.apple.developer.authentication-services.autofill-credential-provider`,
  App Sandbox) and `CredentialProviderViewController.swift`, which answers every AutoFill request with "nothing here".

Steps, in order:

1. In the Apple Developer account (owner only): turn on AutoFill Credential Provider for `com.ardia.browser`, register
   `com.ardia.browser.credentials` with the same capability, and download new Developer ID profiles for both.
2. Add an app extension target `ArdiaCredentials` to `Ardia.xcodeproj` (product `ArdiaCredentials.appex`, bundle id
   `com.ardia.browser.credentials`, deployment target macOS 26, the files above), embed it in the app's PlugIns, and
   sign it in `scripts/release` with its own profile, as the app is.
3. The import entries show by themselves once `Ardia.app/Contents/PlugIns/ArdiaCredentials.appex` exists.
4. Test with real exports from Passwords, then any other password manager at hand, and name only the ones tested.

## Testing without a provider

`ARDIA_TEST=credentialExchangeFixture=<path to a CXF JSON file>` (`packages/import/fixtures/cxf/exchange.json`):
Open Passwords hands that file to the import instead. It goes through Apple's own decoder and the same code as a real
export, so it proves the reading and the saving, not that any app can export to Ardia.
