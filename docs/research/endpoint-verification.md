# Endpoint Verification and the Apple Passwords branch: does the branch put it at risk?

Read-only research, checked 2026-11-27 against `advenimus/apple-passwords` at `31728b71a` (main `ceae550b7` is its merge base, so the branch is main plus 190 files, +11606/-319). Sources: Google's own docs, the Chrome Web Store listing and package, Google's macOS helper installer (opened, never installed), our Chromium tree (`~/chromium-build/chromium_git/chromium/src`, read only), this repo's history and `gh` (read only). Nothing was installed, built, commented or posted. Claims are tagged **[verified]** (read in the source named) or **[inferred]** (reasoned from verified facts).

## Short answer

- **The branch does not touch anything Endpoint Verification depends on [verified].** No file under `engine/patches/` changed, `engine/patches/series` is identical to main, and `ArdiaNativeMessaging.mm`, `chromium-apple-passwords-host-skipped.patch`, `chromium-enterprise-context-info.patch`, the extension-management patches, `ArdiaStartup.mm` and `ArdiaHost+Launch.mm` have no commit on the branch.
- Endpoint Verification works in Ardia today because of **two engine patches that are already on main**: `chromium-enterprise-context-info.patch` (#2290, `e8e242d84`, 2026-11-16) makes `getContextInfo()` answer, and Helium's `scan-chrome-native-messaging-hosts` lets Chromium find Google's helper in Chrome's own `/Library/Google/Chrome/NativeMessagingHosts`.
- The branch's engine changes are five autofill and password hooks plus a tab property. None of them runs for an extension service worker, `chrome.enterprise.*` or native messaging **[verified]**.
- The one real exposure is **indirect**: the branch changes `engine/ardiacore`, so it ships a new Mac engine key. The next engine must still carry the two patches above. The series check (`python3 engine/patches/series.py check`) is the guard, and nothing in the repo tests Endpoint Verification itself (section 5).
- Verdict: **no code change needed.** Optional: one acceptance check (section 6) so a future engine rebuild cannot silently break it again, which is what #1088 was.

## 1. What Endpoint Verification is and what it needs from the browser

**The extension [verified].** Chrome Web Store listing `callobklhcbilhphinckomhgkigmfocg`: "Endpoint Verification", offered by google.com, version 1.140.0, updated 2026-03-02, 10,000,000 users, "Allows Google Workspace administrators to view laptop and desktop status, including OS, device, and user information" (`chromewebstore.google.com/detail/endpoint-verification/callobklhcbilhphinckomhgkigmfocg`). I read the package's `manifest.json` (fetched from Google's update service, unpacked in a scratch dir, never loaded into a browser):

- Manifest V3, service worker `background_service_worker.js`.
- Permissions: `cookies`, `idle`, `nativeMessaging`, `storage`, `alarms`, `enterprise.deviceAttributes`, `enterprise.platformKeys`, `gcm`, `identity`, `identity.email`, `platformKeys`, `enterprise.reportingPrivate`, `offscreen`. Host permission `*://*.google.com/*`.
- The worker calls, by name: `chrome.enterprise.reportingPrivate.getContextInfo`, `getDeviceInfo`, `getDeviceId`, `getPersistentSecret`, `getDeviceData`, `setDeviceData`, `getCertificate`; `chrome.enterprise.deviceAttributes.getDirectoryDeviceId` and `getDeviceSerialNumber`; `chrome.enterprise.platformKeys.*`; `chrome.identity.getProfileUserInfo`; and native messaging to `com.google.endpoint_verification.api_helper` (the only host name in the worker).

**What it does [verified].** "Endpoint Verification consists of a Chrome extension that collects and reports device inventory information by constantly syncing with Google Cloud" (`cloud.google.com/endpoint-verification/docs/overview`). The attributes it reports (screen lock, disk encryption, OS and version, model, serial number, hostname, device ID, Wi-Fi MAC, certificates, Chrome browser attributes) are listed at `.../docs/device-information`; Access Context Manager reads them to allow or block access to Workspace and Google Cloud.

**What Google says about browsers [verified].** "You must use Chrome 110 or later. While you can install Endpoint Verification on any Chromium-based browser, it's supported only on Chrome browser" (`.../docs/quickstart` and `.../docs/deploying-with-admin-console`). So Google does not support Ardia; the user in the Discord message is relying on what Ardia has made work.

**The helper app [verified].**
- On macOS it is optional for the base sync: the install page says "if you see a message that the helper app is required on your device, click Install it" (`.../docs/self-install-extension`). The deploy page lists when it is needed: the CrowdStrike Falcon integration, certificate-based access for Google Cloud, and Chrome M92 or earlier (`.../docs/deploying-with-admin-console`). Configurable attributes need helper 2.11 or later (`.../docs/collect-config-attributes`).
- The macOS installer is `https://dl.google.com/dl/secureconnect/install/mac/EndpointVerification.dmg` (the URL is inside the extension's `popup_script.js`). Opened read-only, its `Endpoint_Verification_Native_Helper.pkg` (Developer ID Installer: Google LLC, notarized) carries:
  - `/Library/Application Support/Google/Endpoint Verification/ApiHelper`, the binary;
  - `/Library/Google/Chrome/NativeMessagingHosts/com.google.endpoint_verification.api_helper.json`, with `"path": "/Library/Application Support/Google/Endpoint Verification/ApiHelper"`, `"type": "stdio"` and `allowed_origins` of seven extension ids, among them `chrome-extension://callobklhcbilhphinckomhgkigmfocg/`;
  - a Firefox manifest in `/Library/Application Support/Mozilla/NativeMessagingHosts/`.
  - There is no manifest for Chromium or for any other Chromium browser **[verified, in the package listing]**. It installs only the Chrome path, system-wide. The helper is registered with Google Software Update (version 2.11.31 in the copy served on 2026-11-27).
- The extension's log in #1088 shows what a missing helper looks like: `Specified native messaging host not found` as a WARNING, and the sync carries on. A missing helper is not what broke the sync in #1088.

**What a Chromium browser must provide [verified from the above].**
1. `chrome.enterprise.reportingPrivate` and the allowlisted `enterprise.*` permissions granted to this extension id. Chromium restricts these to allowlisted ids in its feature files; our probe in #2290 used an unpacked extension carrying the store key, so it got the same id and the same grant.
2. `getContextInfo()` must call back with an object. #1088: it called back with `undefined`, the worker read `realtimeUrlCheckMode` from it and threw.
3. For the optional helper: `connectNative` must find `com.google.endpoint_verification.api_helper`, which on macOS lives only in Chrome's system directory.
4. Keychain access for its own "Endpoint Verification Safe Storage" item (Google's macOS sync troubleshooting names it, `.../docs/troubleshoot-issues-user`). Nothing in this branch touches that.

## 2. How Ardia supports it today

| Piece | Where | What it does | Added by |
| --- | --- | --- | --- |
| `getContextInfo()` answers | `engine/patches/chromium-enterprise-context-info.patch`; series line 118, no platform tag | Drops the `#if BUILDFLAG(ENTERPRISE_CLOUD_CONTENT_ANALYSIS)` in `EnterpriseReportingPrivateGetContextInfoFunction::Run`. Helium builds with `enterprise_cloud_content_analysis=false`, so `Run` answered `NoArguments()` (undefined, no `lastError`). It now always uses `ContextInfoFetcher`. | #2290 `e8e242d84`, 2026-11-16, closes #1088 (also Helium's imputnet/helium#2386). In engine 0.2.47 and later (`git tag --contains`: `engine-0489e70859cf`, `android-v0.2.47`). Windows accepts it too (`scripts/windows/engine/accepted-patches.txt:97`, `docs/engine-build-windows.md:375`). |
| Chrome's host directories are searched | Helium's `helium/core/scan-chrome-native-messaging-hosts.patch`, applied by the build in `~/chromium-build/helium`; our tree shows it in `launch_context_posix.cc` | `FindManifest` tries, in order: `<our data dir>/NativeMessagingHosts`, then Chrome's `~/Library/Application Support/Google/Chrome/NativeMessagingHosts` (user-level hosts only), then `/Library/Application Support/Chromium/NativeMessagingHosts`, then `/Library/Google/Chrome/NativeMessagingHosts`. | Helium, inherited. We list the file as an allowed Helium touch in `engine/patches/build/03-helium.py:100`. |
| `allow_user_level_hosts` | `chrome_messaging_delegate.cc:41-56` | True unless the managed pref `NativeMessagingUserLevelHosts` is false. | Chromium. |

Consequence **[inferred from the two verified rows plus the package listing]**: Google's helper manifest sits at the fourth path, `/Library/Google/Chrome/NativeMessagingHosts/com.google.endpoint_verification.api_helper.json`, so a Mac that has the helper installed for Chrome has it found by Ardia with no copying. `ArdiaNativeMessaging.mm` is **not** involved. Its `KnownHosts()` names only 1Password, Bitwarden, KeePassXC and Proton Pass, and `SystemRegisteredHosts()` names only `com.apple.passwordmanager` (`ArdiaNativeMessaging.mm:20-70`). It never creates, edits or removes an Endpoint Verification manifest: it only removes names listed in its own `.ardia-managed.json` (`SyncHosts`, last loop).

#2290's own proof is a probe extension with the store key calling `getContextInfo` (before: `undefined`; after: an object with `realtimeUrlCheckMode: "DISABLED"`, `browserVersion`, `siteIsolationEnabled`, `osFirewall` and more), and its description says "Not checked: a real Workspace account with Endpoint Verification syncing." PR #1621 (open, same fix under another patch name, `chromium-ungoogled-context-info.patch`, not merged) reports the real thing: on a profile signed in to a managed Workspace account the extension's log shows the sync finishing and `/v1:reportDeviceState` answering `OK` **[verified as reported in its body; I did not reproduce it]**. `getDeviceId` still fails in a build without Chrome branding ("Failed to retrieve the device id"); the extension catches it (#1088 log, #1621 body).

No other repo mention exists: `git log --all -i -S "endpoint verification"` finds only `e8e242d84`, the engine-build commit that accepted it for Windows (`3dec89480`) and two release commits that list it.

## 3. What the branch changes in those paths

`git diff main...advenimus/apple-passwords --name-only`, then each candidate checked with `git log main..HEAD -- <path>` **[verified]**:

| Path | Commits on the branch |
| --- | --- |
| `packages/ardiacore/ios/ArdiaNativeMessaging.mm` / `.h` | none (last change on main `2c19cea1b`, 2026-11-24) |
| `engine/patches/chromium-apple-passwords-host-skipped.patch` | none (on main since `f45cdd89f`, 2026-11-21) |
| `engine/patches/chromium-enterprise-context-info.patch` | none |
| `engine/patches/series` and everything under `engine/patches/` | none |
| `chromium-extension-management-policy-hook.patch`, the other `chromium-extension-*` patches | none |
| `ArdiaStartup.mm`, `ArdiaHost+Launch.mm`, `acceptance.mjs` | none |
| `docs/engine-build.md` | three added lines (docs only) |

A search of the whole branch diff for added lines naming `nativeMessaging`, `connectNative`, `NativeMessagingHosts`, `enterprise.`, `reportingPrivate`, `allowed_origins`, `callobkl` or `extension_management` hits only docs and tests that read Apple's own host manifest (`ApplePasswordsClient.swift:9` lists the two directories Apple's manifest sits in, `fake-helper.mjs` writes a fake one) **[verified]**.

**Could `chromium-apple-passwords-host-skipped.patch` hit Endpoint Verification?** No **[verified]**. The branch does not change it, and the guard is `host_name == "com.apple.passwordmanager"` before anything else (`launch_context_posix.cc` in our tree); any other host name falls through to the normal four-directory search shown in section 2.

**Ticket 11 (turning off the iCloud Passwords extension per profile).** `apps/browser/src/state/site/iCloudPasswordsExtension.ts` (new file, `784efee2b`) calls the existing `setExtensionEnabled(ICLOUD_PASSWORDS_EXTENSION_ID, profile, enabled)`, with the id hard-coded as `pejdijmoenmkgeppbflobdenhhabjlaj`, and only when a profile's password manager choice flips to or from "apple". It first checks that exact id is enabled in `listExtensions(profile)`, records the profile in `icloud-passwords-extension.json` and refreshes the extension lists **[verified]**. It did not modify `platform/extensions` or any shared enable and disable code; no `engine/` file in the branch deals with extensions. Endpoint Verification's id never reaches it.

**Do the engine hooks reach extensions or native messaging?** No **[verified]**. The branch's `engine/ardiacore/apply.sh` adds, each behind a null function pointer and each in code that runs for a page's `WebContents`:
- `AutofillPopupControllerImpl::Show` and `AcceptSuggestion` (autofill dropdown claimed or heard);
- `ContentPasswordManagerDriver::PropagateFillDataOnParsingCompletion` (Chrome's saved logins kept out of a tab);
- `PasswordGenerationFrameHelper::IsGenerationEnabled` (generation off for a tab);
- `PasswordManager::OnLoginSuccessful` (a submitted login offered through the prompt).

Plus `ardiacore_tab.mm` (`pendingLogin`), `ac_autofill_suppress.mm`, `ac_password_prompt.mm` and a new BUILD.gn dependency on `//components/password_manager/content/browser`. Endpoint Verification is a service worker with an offscreen document; it reads and writes no web form, so it never enters these paths **[inferred: the worker has no content script, `host_permissions` is only `*://*.google.com/*`]**.

**Indirect effects on a page the extension helps with.** Endpoint Verification's popup asks the user to sign in to a Google account (`Add account`, `.../docs/self-install-extension`). That sign-in happens at a Google page in a tab like any other, so it gets the same Apple Passwords login list as any site on an Apple Passwords profile. That is the feature working, not a regression of Endpoint Verification.

## 4. The one real exposure: a new engine

`engine/engine-key.sh` hashes everything under `engine/` for the Mac key, so the branch's `engine/ardiacore` changes produce a new Mac engine **[verified, header of `engine/engine-key.sh`]**. Risks that follow, and where each is guarded:

- **A patch drops out of the series or no longer applies.** Guard: `python3 engine/patches/series.py check` ("86 steps reproduce the tree" in #2290's run; the count changes as patches are added). The branch leaves the series unchanged, so the enterprise patch stays on its line.
- **A Chromium version bump moves `EnterpriseReportingPrivateGetContextInfoFunction::Run`.** The tree now is 158.0.8127.36 (`chrome/VERSION`). The patch applies there today (the `#if` block is gone in the tree's function). A bump that reflows the function is the likely way this breaks, and it would break the same way #1088 did, silently, with no failing test.
- **Helium's directory scan changes or is dropped on a rebase.** `03-helium.py:100` marks it, but nothing asserts that the fourth path is searched.

## 5. What tests this today

None **[verified: `grep -rniE "reportingPrivate|getContextInfo|endpoint.?verification" ` over the repo, excluding `node_modules` and `.git`, finds only `docs/engine-build.md`, `docs/engine-build-windows.md`, `scripts/windows/engine/accepted-patches.txt`, the patch and the series]**. `packages/ardiacore/scripts/acceptance.mjs` has `startup-native-messaging` (line 6221), which proves a user-level host manifest works end to end with an echo host and a fixture extension, but it uses a made-up host name and no `enterprise.*` call.

## 6. Verdict and the smallest regression check

**Does it need doing?** No fix is needed for this branch. Endpoint Verification's two dependencies are in files the branch leaves alone, and the branch's hooks sit in page autofill and password code. Reply to the Discord user that the Apple Passwords work does not change the engine paths Endpoint Verification uses.

**If a check is wanted** (recommended before the next Chromium bump or engine rebuild, not before merging this branch), add one acceptance check beside `startup-native-messaging`, in a hidden instance on a scratch data dir:

1. Unpack the extension for a probe: a manifest with Endpoint Verification's store public key (so the id is `callobklhcbilhphinckomhgkigmfocg` and the allowlisted `enterprise.reportingPrivate` permission is granted, the method #2290 used) and the permissions `enterprise.reportingPrivate` and `nativeMessaging`. Do not install Google's extension or helper.
2. From the probe's service worker, call `chrome.enterprise.reportingPrivate.getContextInfo(cb)`. Pass when `cb` receives an object with a `realtimeUrlCheckMode` key and `chrome.runtime.lastError` is unset. This is the exact assertion #1088 broke.
3. Write a stub manifest `com.google.endpoint_verification.api_helper.json` into `<scratch>/NativeMessagingHosts` (our user-level directory, so no root is needed; the echo host from `startup-native-messaging` is the stub), with `allowed_origins` set to `chrome-extension://callobklhcbilhphinckomhgkigmfocg/`. Pass when `chrome.runtime.sendNativeMessage("com.google.endpoint_verification.api_helper", …)` returns the echo. That proves the host name is findable and the extension id is allowed, but not the fourth search path (it needs a file in root-owned `/Library/Google/Chrome/NativeMessagingHosts`).
4. For that path, a source check is enough and cheaper: assert in the engine-patch checks that `launch_context_posix.cc` still references `DIR_CHROME_NATIVE_MESSAGING` after the series applies.

Steps 1 and 2 are about 30 lines, and they catch the failure that did happen. Step 3 adds the host-name check for the same runtime cost.

**Not verified.** A real Workspace sync on this branch's engine (needs a Workspace account and the helper installed); the helper's behaviour when launched by Ardia's process (the macOS installer grants it no launch constraints that I read: its postinstall only registers with Google Software Update, but I did not inspect the helper binary's own code-signing requirements); and whether Windows or Linux look in the equivalent Chrome directories (Windows is a registry key, and Helium's own patch says its Windows support is missing: "this is not supported on windows" in the patch's comment).

## Also found

- The #1088 reporter's log also shows `Specified native messaging host not found` for the helper, and they guessed Ardia looks only in its own directory. That log does not say whether the helper was installed on their Mac, and I did not find an issue that tracks it. With the helper installed, the Helium scan above should find it; nobody has confirmed that on a Mac with Google's helper.
- PR #1621 (open) fixes the same bug under a different patch name; closing it as a duplicate of #2290 would avoid a second patch for the same function.
- Google's Endpoint Verification docs say the extension works on any Chromium browser but is supported only on Chrome (`.../docs/quickstart`), so the user's setup is unsupported by Google and rests on the two patches above.
