# Building the engine from source

Ardia runs on ArdiaCore: Chrome's own framework (`//chrome:chrome_framework`) built from our Chromium tree, with our
layers linked in (`docs/ardiacore-spike.md`). The tree is **Chromium 158.0.8127.36** (`CHROMIUM_VERSION` in
`env.sh`), plus **Helium** 0.22.2 (helium-chromium) and 0.22.2.1 (helium-macos) minus a short skip list, then our
patch series. Nothing of CEF's is checked out or built. CEF left the tree
on 2026-10-09: its 117 patches to Chrome are gone, except a few kept as `chromium-cef-carryover.patch`
([below](#cefs-117-patches)), and the seams of theirs ArdiaCore used are our own hooks H1–H6
([below](#our-hooks-in-chromes-code)). The framework is still named "Chromium Framework". Crashpad stays off.

What the build adds:

- **H.264 / AAC.** Set with `proprietary_codecs=true` and `ffmpeg_branding="Chrome"`; H.264 decodes
  through VideoToolbox.
- **Chrome's release optimisations**, as Helium ships them: an official build with ThinLTO and PGO (Chromium's own
  mac-arm profile).
- **Helium** (`HELIUM_TAG` and `HELIUM_MACOS_TAG` in `env.sh`, pinned by commit in `helium-pins.ini`). It is built on
  ungoogled-chromium: its series, domain substitution and name substitution strip Google's background services and
  rename the product, and we rename it again, to Ardia. Helium's own services stay off, and the Chrome Web Store,
  extension updates and the security components still reach Google. See [Helium](#helium).
- **Our patches**, in `engine/patches/`, applied in the order `engine/patches/series` gives (see
  [The patch series](#the-patch-series)). Each row says what the patch does and when it can go: when upstream,
  Helium or Ardia changes so the patch has nothing left to do, or "never" for Ardia's own features:

| Patch | What it does | Removable when |
|---|---|---|
| `chromium-helium-branding.patch` | First in the series: Helium shows as Ardia, and its services, update feed and crash server can't be reached, for the literals in source that name substitution and `ardia_resources.txt` don't reach. `helium::ShouldAccessServices` is false whatever the prefs say, and both services origins are the unresolvable `services-disabled.qjz9zk`; the update feed and the crash upload URL are empty (no switch sets one) and the crash product is Ardia. Helium's internal-page scheme alias isn't registered, rewritten or shown (the engine shows chrome://, the app shows ardia://). Extension update pings go to no domain (they did to helium.computer). chrome://credits names Ardia and its repository and keeps Helium's GPL-3.0 entry; chrome://crashes files bugs on Ardia's tracker; the Safari import dialog loses its link to Helium's wiki; screenshots save as `ardia_screenshot*.png` and the Web Store's button says "Add to Ardia"; chrome://flags loses the Proxy server and Proxy bypass list flags (Helium 0.20.1's; on a real profile ArdiaCore drops `--proxy-server` from the browser's command line after chrome://flags apply, so they did nothing there) and Helium's colours; Helium's own flags (their `ardia-*` ids, chrome://flags text, and the removed updater channel and update server flags) are in `chromium-helium-branding-mac.patch` and `chromium-helium-branding-linux.patch`. `cr:chrome-product` is Ardia's mark, Helium's indigo palette is reverted (`helium-color-scheme`), the onboarding page and Helium's uBlock Origin aren't registered (their `-off` patches leave out their paks), and `chrome/app/theme/chromium/BRANDING` is Chromium's again (Ardia builds with its own, `chromium-branding.patch`) | Never while the tree carries Helium; a hunk goes when Helium drops the literal or service it covers |
| `chromium-helium-branding-mac.patch` | The Mac half of the branding patch: Helium's own flag switches (`helium-noise*`, `helium-split-clienthello`, `helium-native-frame-materials`, …) are `ardia-*`, their chrome://flags text says Ardia, Helium's update channel and update server flags are gone, and the full disk access dialog Helium carries (from Brave) has no help link to Helium's site | With `chromium-helium-branding.patch`: a hunk goes when Helium renames or drops the flag, or drops the dialog's link |
| `chromium-helium-branding-linux.patch` | The Linux half of the branding patch: the same flag switches, chrome://flags text and removed update channel and update server flags as the Mac half, on Linux's copy of `helium_flag_choices.h` and `helium_flag_entries.h` (Linux shows `helium-middle-click-paste-enabled` too, renamed) | With `chromium-helium-branding.patch`: a hunk goes when Helium renames or drops its flag |
| `chromium-cef-carryover.patch` | The CEF patches we keep ([CEF's 117 patches](#cefs-117-patches)), shared hunks: `BrowserManagerService::DeleteBrowser`'s destruction order, the tab strip API's colour provider without an active tab, and `browser_tests` building without background mode (for `enable_background_mode=false`). The rest of the carryover (Mac key codes, `kAdjustBubbleIfOffscreen`, the `remote_cocoa` resize and child-modal focus hunks, `LoadLocalState`'s delegate) is in `chromium-cef-carryover-mac.patch` | Hunk by hunk: `DeleteBrowser`'s order goes when ArdiaCore stops relying on it, the others when upstream ships the same fix ([CEF's 117 patches](#cefs-117-patches) names each) |
| `chromium-cef-carryover-mac.patch` | The Mac half of the CEF carryover: no `NOTREACHED` for unmapped Mac key codes (`keyboard_code_conversion_mac.mm`), no off-screen adjustment of bubbles on the Mac (`kAdjustBubbleIfOffscreen` true on Windows only; Chrome adjusts everywhere but Linux), and in `remote_cocoa` AppKit's native resize edges over a blocked page and the child-modal sheet's focus back after its parent's resize; and the ResourceBundle delegate parameter H5 passes to `LoadLocalState` (`chrome_resource_bundle_helper`) | Hunk by hunk: `LoadLocalState`'s delegate goes when H5 stops passing one, the others when upstream ships the same fix |
| `chromium-extension-window-hidden.patch` | The windows of ArdiaCore's own pages are invisible to chrome.windows/tabs (`g_ardia_hidden_from_extensions`, also read by the next patch and apply.sh's `browser_window_util` hook): not listed, not found by id (`ExtensionTabUtil::GetTabById` and `GetControllerInProfileWithId`, so tabs.get/update/remove, scripting and tabs.sendMessage on a leaked id fail as for a closed tab), no tabs events (`TabsEventRouter::ShouldTrackBrowser`) and no webNavigation events for their tabs, or for tabs they open | Never: ArdiaCore's own windows must stay out of the extension APIs |
| `chromium-component-extension-restricted-urls.patch` | Chrome lets every `kComponent` extension script any page (`PermissionsData::CanExecuteScriptEverywhere`), Web Store included. For the component extensions Ardia bundles (`g_ardia_restricted_component_extension`, set in every process by `ACMainDelegate`: uBlock Origin's id), `IsRestrictedUrl` makes Chrome's usual checks anyway: no scripts on the Web Store, chrome:// pages or other extensions' pages. Nothing else about `kComponent` changes | Ardia stops bundling uBlock Origin as a `kComponent` extension, or Chromium restricts component extensions' scripting itself |
| `chromium-component-extension-disk-messages.patch` | Helium's `add-component-l10n-support` reads a `kComponent` extension's `_locales` only from the resource packs, so uBlock Origin, a component Ardia loads from `Contents/Resources/Extensions/ublock`, got an empty catalog and every `chrome.i18n.getMessage` was `""` in every language (its pages and its blocked-page text blank). `RendererStartupHelper::GetMessageBundle` takes Helium's packed path only when the default locale's `messages.json` is a component resource, and reads the rest from disk as for any extension, so they follow the UI locale with Chrome's fallbacks (#488) | Helium's `add-component-l10n-support` falls back to an on-disk `_locales`, or Ardia stops loading uBlock Origin as a component from disk |
| `chromium-helium-ublock-off.patch` | Helium's uBlock Origin component (`blockjmkbacgjkknlgpkjjiijinjdanf`) is neither built nor loaded, and isn't pinned by default: no `AddUBlock`, no `//third_party/ublock` deps, `ublock_resources.pak`, grit headers or resource entries. Ardia runs its own uBO (`fajbdaomknpkicfjcpipdmcpoamdmilh`), so users keep their filters and two engines don't filter every request | Helium stops bundling its uBlock Origin component, or Ardia moves its users' filters to Helium's copy |
| `chromium-helium-onboarding-off.patch` | Helium's onboarding page (chrome://setup) isn't built: no WebUI target, resources, pak, strings, chrome://chrome-urls entry or first-run opener (the branding patch drops its registration), so Helium's services consent stays off. chrome://credits keeps Helium's GPL-3.0 entry with its licence text in `third_party/helium/LICENSE`, and leaves out the onboarding font | Helium drops chrome://setup or puts it behind a build flag `gn_defines.sh` can turn off |
| `chromium-helium-services-page-off.patch` | Settings has no Helium services page: no route, no view, no "set up services" button opening chrome://setup. Helium services stay off in Ardia (the branding patch, which also removes its row), so it only offered switches that do nothing | Helium drops its services settings page or puts it behind a build flag |
| `chromium-helium-search-assets-off.patch` | Built-in search provider assets are on only for Chrome-branded builds again (Helium turns them on; `enable_builtin_search_provider_assets` in `chrome_build.gni` isn't a GN argument): the build doesn't fetch Helium's non-free search engine assets | Helium stops turning on `enable_builtin_search_provider_assets`, or it becomes a GN argument |
| `chromium-helium-bangs-off.patch` | Helium's `BangManager` (add-native-bangs) never fetches: `LoadBangs` answers at once with an empty catalogue whatever the prefs say, so no loader is made, no retry is armed and nothing is requested (before Helium 0.20.2 it made a cache-only request to the services-disabled placeholder at every launch). Chromium's omnibox never uses bangs in Ardia; the address bar is the app's own (`packages/core`) | Helium drops `add-native-bangs` or puts its fetch behind a build flag |
| `chromium-helium-web-push-off.patch` | Helium 0.22's web push (an autopush WebSocket to Helium's push server for sites with a push subscription, behind the `HeliumWebPush` feature and Helium's services consent) can't be turned on: `ShouldAccessPushService` is false whatever the prefs say, the default push server is the unresolvable services placeholder, and `GCMProfileServiceFactory` never builds the `AutopushDriver`, whatever the feature says | Helium drops `HeliumWebPush` or puts it behind a build flag |
| `chromium-helium-translate-providers-off.patch` | Helium 0.22's translation provider API (the `HeliumTranslate` feature; a registered provider is sent the page's text) has no provider and can't get one: `HasTranslationProvider` is false whatever the feature says, so Chrome's Translate menu items, bubble and settings section stay hidden and no page text leaves the renderer | Helium drops `HeliumTranslate` or puts it behind a build flag |
| `chromium-helium-rlz-for-cdm-storage-id.patch` | `enable_rlz` can be true again (`gn_defines.sh` sets it): it reverts the `rlz/buildflags/buildflags.gni` hunk of the `disable-rlz` patch Helium applies, as our ungoogled build did. Widevine's CDM storage id (`enable_cdm_storage_id`) hashes RLZ's machine id on the Mac, so every user's storage ids and licences stay the same. RLZ itself stays inert: there's no brand code | Helium's `disable-rlz` leaves `rlz/buildflags/buildflags.gni` alone, or Widevine's CDM storage id stops hashing RLZ's machine id |
| `chromium-helium-ntp-third-party.patch` | chrome://newtab opens the New Tab page Ardia 0.2.39 did: chrome://new-tab-page-third-party unless Google is the default search engine. It reverts the `search.cc` hunks of Helium's `always-use-better-ntp`, which sent every engine to Chrome's WebUI NTP (it needs a BrowserView, which ArdiaCore's browsers lack), and puts back the `search.cc` part of ungoogled's `0008-restore-classic-ntp`, which Helium leaves out | Both hold: Helium drops the `search.cc` hunks of `always-use-better-ntp` and itself carries the `search.cc` part of ungoogled's `0008-restore-classic-ntp` (chrome://newtab is the third-party page unless Google is the default engine); or ArdiaCore's browsers get the BrowserView Chrome's WebUI New Tab page needs and Ardia accepts that page |
| `chromium-helium-context-menu-cast.patch` | The page's context menu keeps Cast…, as in 0.2.39: it reverts the `AppendPageItems` hunk of Helium's `degoogle-context-menu`. Cast works through `chromium-cast-dialog-hook.patch`, with mDNS on | Helium's `degoogle-context-menu` keeps Cast…, or Ardia drops Cast from the page menu |
| `chromium-helium-devtools-inspect-shortcut.patch` | DevTools' Select an Element (`elements.toggle-element-search`) is ⇧⌘C again, as in Chrome and 0.2.39: it reverts the `elements-meta.ts` hunk of Helium's `keyboard-shortcuts`, which moved it to ⇧⌘E, so ⇧⌘C in a focused DevTools fell through to the app's Copy URL. Helium's other changes there (`IDC_COPY_OR_INSPECT_SHORTCUT`, its reserved commands and global shortcut table) don't reach ArdiaCore's windows, whose keys go through ArdiaCore's own command dispatcher and the app's menu | Helium's `keyboard-shortcuts` leaves DevTools' ⇧⌘C alone |
| `chromium-password-bubble-hook.patch` | ArdiaCore may replace Chrome's password bubble (`g_ardia_password_bubble`) | Never: Ardia feature (its own password bubble) |
| `chromium-extension-install-prompt-hook.patch` | ArdiaCore may replace Chrome's extension install dialog (`g_ardia_extension_install_prompt`) | Never: Ardia feature (its own install dialog) |
| `chromium-branding.patch` | Ardia's bundle and team id (`branding_file_path`), for the passkey and payments keychain access groups; product names stay "Chromium" | Never: Ardia's bundle and team id |
| `chromium-safe-storage-name.patch` | The Safe Storage key lives in its own "Ardia Safe Storage" keychain item, account "Ardia". **Load-bearing:** it's Chromium's own `os_crypt` code, so ArdiaCore uses it too, and every user's saved passwords and cookies are encrypted with that item's key. Keep it, unchanged, through every re-sync and version bump; without it Chrome reads "Chromium Safe Storage" and nothing decrypts | Never: every user's saved passwords and cookies are encrypted with this item's key |
| `chromium-safe-storage-no-silent-reset.patch` | Ardia never replaces its Safe Storage key. Chromium added a new key whenever the item didn't show up, and its add looked the item up again and overwrote it if it was there by then, so an item briefly invisible at login left every saved password and cookie undecryptable. Now a missing item may be created only when `g_ardia_safe_storage_key_may_be_created` says so: ArdiaCore (`ac_safe_storage.mm`) allows it when, at startup, the user data dir had no `Local State` and no entry holding `Preferences`, `Cookies`, `Network/Cookies`, `Login Data` or `Web Data` and every check answered cleanly (any error but "not found", and any link that doesn't resolve, counts as existing data), or once after the user chose to start over. The add is add-only (`KeychainV2::AddGenericPasswordIfAbsent`): an item that appeared meanwhile is read back, never overwritten. Otherwise the key provider retries 3 × 1 s and fails closed; `g_ardia_safe_storage_unreadable` then gets the error and the retry, and ArdiaCore asks: a missing item, "Ardia can't read its Safe Storage key." with Quit (the default) or Start Over with a New Key, the only choice that lets one key be made; a locked keychain or denied access, unlock it or allow Ardia in Keychain Access; a missing entitlement, reinstall Ardia from ardia.dev; an undecodable secret, "Ardia's Safe Storage key is damaged." (restore the keychain from a backup, or delete the item and try again, which then reaches the missing-item dialog); anything else, a neutral try-again. Each of those offers Quit or Try Again and creates nothing. Test instances can use a file-backed keychain (`ARDIA_TEST` `keychain=file`, `keychainHiddenReads=<n>`, `keychainFail=decode\|denied\|interaction\|entitlement\|io`, `safeStorageAnswer=start-over`), honoured only by the test gate (`ac_launch_switches.cc`: not signed for distribution, the mock keychain, `--user-data-dir` resolving to `--ardia-data-dir`/Chromium) | All of these hold upstream: a Safe Storage key is written add-only, never over an item that appeared meanwhile; a missing item is never created for a profile that already has data, only for a fresh data dir or on the user's explicit choice; and a key that can't be read fails closed with a way to retry, start over with a new key or quit. Until then the patch and `ac_safe_storage.mm`'s recovery dialogs stay |
| `chromium-safe-storage-one-key-for-every-data-dir.patch` | Chromium 158 gives a browser on a non-default user data directory its own Safe Storage key: with `KeychainKeyProviderUserDataDirProtection` (on by default) the "v10" key is reported unavailable and new data is encrypted as "v11" with another salt. ArdiaCore always passes `--user-data-dir`, so every Ardia profile would count as non-default and every user's saved passwords and cookies would stop decrypting. Ardia keeps the one provider and the one key for every data directory, whatever the feature says | Never while users' data is encrypted with the one "v10" key; moving to per-directory keys would need a migration that re-encrypts it first |
| `chromium-pref-hash-safe-storage-key-change.patch` | A profile keeps its extensions and protected settings when the Safe Storage key changes. A tracked preference's encrypted hash (made with the Safe Storage key) that doesn't verify falls back to its legacy HMAC (seed and machine id): if that holds, the value stays and Chrome re-hashes it with the current key; if not, it resets as before. Chrome had removed every extension and turned developer mode off in a profile hashed under an earlier key (FB-5GA3). It trusts nothing Chrome doesn't: a preference with no encrypted hash is checked by its HMAC alone, and `kDisallowLegacyPrefMacFallback` still turns every fallback off | Chromium itself falls back to a preference's HMAC when its encrypted hash doesn't verify |
| `chromium-device-chooser-hook.patch` | `chrome::ShowDeviceChooserDialog` (and its extension-page variant) asks ArdiaCore (`g_ardia_device_chooser`) once Chrome's `DropFullscreenForChooserDialog` has dropped the page's full screen and revalidated the frame and active tab: ArdiaCore gets that WebContents and the full-screen blocker, which its chooser holds until it closes | Never: Ardia feature (its own device chooser) |
| `chromium-media-access-hook.patch` | `MediaCaptureDevicesDispatcher::ProcessMediaAccessRequest` asks ArdiaCore first (`g_ardia_media_access_request`, `ac_desktop_capture.mm`'s `AnswerNativeDisplayCapture`), whichever delegate passed the request on (a tab, Document Picture-in-Picture, an extension host): while pages pick their display media natively, a page's screen or window capture without a click is refused (`NO_TRANSIENT_ACTIVATION`); everything else goes on to Chrome's handlers | Never while pages pick their display media natively (`ac_desktop_capture.mm`) |
| `chromium-cast-dialog-hook.patch` | The Media Router's Cast dialog (and Presentation API requests) asks ArdiaCore first (`g_ardia_wants_cast_dialog`, `g_ardia_cast_dialog`). Both paths reach `CreateMediaRouterDialog`, which asks ArdiaCore only after Chrome's `ForSecurityDropFullscreen` has dropped the page's full screen and the window has survived the drop; ArdiaCore gets the full-screen blocker and its Cast dialog (`ac_cast_dialog.mm`) holds it until it closes, so a page can't re-enter full screen over the picker | Never: Ardia feature (its own Cast dialog) |
| `chromium-side-panel-hook.patch` | `side_panel_util` asks ArdiaCore first for an extension's side panel (`g_ardia_extension_side_panel`) | Never: Ardia feature (extension side panels in its own UI) |
| `chromium-ntp-promo-without-side-panel.patch` | `NewTabPageFeaturePromoHelper::MaybeTriggerAutomaticCustomizeChromePromo` returns when the tab's browser has no `SidePanelUI`, which ArdiaCore's browsers don't: Chrome's WebUI New Tab page crashed the browser (`SIGSEGV`) there on Helium | Chromium checks for a missing `SidePanelUI` there itself, or ArdiaCore's browsers get one |
| `chromium-storage-pressure-bubble-without-browser-view.patch` | `StoragePressureBubbleView::ShowBubble` returns when the last active browser has no `BrowserView`, which ArdiaCore's browsers don't: when the disk ran low, Chrome's storage pressure bubble dereferenced the missing view and crashed the browser (`SIGSEGV` in `toolbar_button_provider()`, 0.2.42 to 0.2.44-nightly.3). Ardia shows no storage pressure bubble | Chromium checks for a missing `BrowserView` in `ShowBubble` itself |
| `chromium-remoting-dialog-without-browser-view.patch` | `MediaRemotingDialogCoordinatorViews::Show` refuses remoting (its permission callback gets false) when the tab's browser has no `BrowserView`, which ArdiaCore's browsers don't: a video starting Cast media remoting dereferenced the missing view and crashed the browser (`SIGSEGV` in `toolbar_button_provider()`, 0.2.43, #951) | Chromium checks for a missing `BrowserView` in `MediaRemotingDialogCoordinatorViews::Show` itself |
| `chromium-action-open-popup-without-active-tab.patch` | `HasPopupOnActiveTab` answers false when the browser has no active tab, so `chrome.action.openPopup()` fails with "no active popup": an ArdiaCore window's Browser can have no tab (only Ardia's New Tab page), and an extension's call there dereferenced the missing tab (`SIGSEGV`, 0.2.44, #950) | Chromium handles a browser with no active tab in `HasPopupOnActiveTab` |
| `chromium-active-web-contents-without-active-tab.patch` | `ExtensionTabUtil::GetAllActiveWebContentsForContext` skips a window with no active tab instead of reading its contents: an ArdiaCore window's Browser can have none (only Ardia's New Tab page), and an extension's `declarativeNetRequest.setExtensionActionOptions` (badge counts) then dereferenced the missing tab (`SIGSEGV` in the browser process, 0.2.44 and 0.2.45-nightly.4) | Chromium handles a window with no active tab in `GetAllActiveWebContentsForContext` |
| `chromium-extension-state-mirror-hooks.patch` | ArdiaCore hears every change to an extension's storage, every firing of its alarms and every change to its declarativeNetRequest rules, so the WebKit copy of the extension (macOS 15.4+) can be a replica of Chromium's: `StorageFrontend::OnSettingsChanged` calls `g_ardia_extension_storage_changed` (context, id, area, changes) before it looks for listeners, `AlarmManager::OnAlarm` calls `g_ardia_extension_alarm_fired` (context, id, alarm) before its delegate, and `RulesMonitorService` wraps the callbacks of `UpdateDynamicRules`, `UpdateSessionRules`, `UpdateEnabledStaticRulesets` and `UpdateStaticRules` so a successful one calls `g_ardia_dnr_rules_changed` (context, id, `dynamic`, `session` or `rulesets`), holding the context by its `WeakPtr`, so a reply that arrives after the profile is gone calls nothing. `ac_extension_storage.cc`, `ac_extension_alarms.cc` and `ac_extension_dnr.cc` set the hooks on first use and pass on only changes for the extensions the app watches (`ac_extension_storage_watch`, `ac_extension_alarms_watch`, `ac_extension_dnr_watch`), as `extensions.storageChanged`, `extensions.alarm` and `extensions.dnrChanged`. Written against Chromium 158.0.8127.36 and never built: strict `git apply --check` passes on that tag's vanilla `alarm_manager.cc`, `storage_frontend.cc` and `rules_monitor_service.cc` (offsets of 1 to 2 lines, no fuzz) and the hook signatures were read from its headers, but no engine has compiled it yet. Run `series.py capture-base` before it first goes into the tree, it is the first to touch all three files. Windows skips it (`series-win`) and builds none of the replica calls: BUILD.gn lists them, `ac_local_storage.cc` and `ac_passwords_page.cc` under `if (!is_win)`, ahead of the Linux dispatch registry that reads them | WebKit pages stop running a replica of each Chromium extension |
| `chromium-tpm-metrics-off.patch` | Chrome's TPM latency measurement (`crypto::MaybeMeasureTpmOperations`) is compiled out on the Mac. It only feeds a usage-stats histogram Ardia never sends, but on the unknown channel Chrome samples it on every launch: 45 s in, it created Secure Enclave keys in the login keychain and deleted them with `SecItemCopyMatching` over the keychain, about 0.6 s of browser-process CPU per launch, which on Chromium 157 landed in the idle window and failed the 0.2.45 perf gate (idle CPU at 1 tab, browser process 0.87 → 2.16 %) | Chromium stops sampling TPM latency on the unknown channel, or moves it off the launch path |
| `chromium-initial-document-access.patch` | When another frame touches a tab's initial empty document (`RenderFrameHostImpl::DidAccessInitialMainDocument`, primary frame tree), ArdiaCore hears it (`g_ardia_initial_main_document_accessed`): the tab sends a URL and navigation-state change, as Chrome's omnibox stops showing the pending URL then. `content::ArdiaHasAccessedInitialMainDocument` answers `WebContentsImpl::HasAccessedInitialDocument`, which 155 no longer has on the public `WebContents`; `ArdiaCoreTab.initialDocumentAccessed` and `.committedInitial` (the last committed entry is the initial one) report them | Chromium puts `HasAccessedInitialDocument` and a notification for it back on the public `WebContents` |
| `chromium-hidden-window-current-window.patch` | Extension pages in hidden windows (our popups and side panels) take the last active window as their current window | Never while extension popups and side panels live in ArdiaCore's hidden windows |
| `chromium-webstore-direct.patch` | Web Store installs and extension updates go straight to Google, as before Helium. It reverts what Helium's `proxy-extension-downloads` and `spoof-extension-downloader-platform` and ungoogled's `disable-webstore-urls` do (Helium's later patches need them, so they can't be skipped): the store update URL is `clients2.google.com` again (Helium's proxy needs onboarding consent, so every install and update went to a dummy host), pending installs (sync ones included), effective update URLs, the standalone installer and `ExtensionUpdater` (the update service again, which carries the Omaha attributes) no longer swap in the proxy, requests name the real platform (`os=mac`, `prod=chromiumcrx`) instead of Windows, and `ChromeContentVerifierDelegate::IsFromStore`, the store's dedicated process and the downloader's defaults are Chromium's code again (content verification itself stays unenforced, as in unbranded Chromium before Helium). Helium's no-utm_source choice stays | Helium stops proxying Web Store downloads and spoofing the platform (`proxy-extension-downloads`, `spoof-extension-downloader-platform`), or makes both optional, and no longer applies ungoogled's `disable-webstore-urls`, so the store's update and item-snippet URLs work unpatched |
| `chromium-extension-updates.patch` | The extension update service (`ChromeUpdateClientConfig::UpdateUrl`) checks `https://clients2.google.com/service/update2/json`: Helium leaves `ConfiguratorImpl::UpdateUrl` empty, and domain substitution cut off its default host. (Its first hunk, undoing ungoogled's early `return` in `UpdateCheckerImpl::CheckForUpdates`, went: Helium's `reenable-update-checks` does the same) | Helium sets `ConfiguratorImpl::UpdateUrl` to Google's update service itself |
| `chromium-component-updater-security-only.patch` | The component updater fetches only the security components: CRLSet (`hfnkpimlhhgieaddgfemjhofmfblmnib`), PKI Metadata (`efniojlnjndmcbiieegkicadnoecjjef`: CT log list, Chrome Root Store, pins) and the SSL error assistant (`giekcmmlnklenlaomppkphknjmnnpneh`). `CrxUpdateService::GetCrxComponents` hands update_client no data for any other id, so scheduled and on-demand checks leave them out of the request; they stay registered, so a bundled or installed copy still loads, and a check of one ends in "Update error" without a request. `ChromeConfigurator` (the component updater's alone; the extension updater keeps its own) checks `https://update.googleapis.com/service/update2/json` with no override and no http fallback (Helium leaves `ConfiguratorImpl::UpdateUrl` empty, so nothing reads `kUpdaterJSONDefaultUrl`), sends no pings, and downloads in Chrome's network stack only (no background cache, so no NSURLSession). Its fetcher gets a destination policy (`NetworkFetcherChromiumFactory`'s `AllowedDestinationPredicate`, null for the extension updater): the update check may go only to that URL, downloads only to https `dl.google.com` or `*.gvt1.com` (any path) or `www.google.com/dl/` (port 443), checked on the first URL and on every redirect, so the server's http mirrors fail over to the https ones and a redirect elsewhere stops before it is followed; an empty request body is refused. Its requests keep only an allowlist of fields: `protocol`, `ismachine`, `dedup`, `acceptformat`, `sessionid`, `requestid` (both random per check), `@updater`, `prodversion`, `updaterversion`, `@os`, `arch`, `os`, the channels, and per component `appid`, `version` and `updatecheck`. The persisted fields Chrome uses to tie one check to the next stay out (`ping` with its `ping_freshness` UUID and day counts, `cohort*`, `installdate`, `iid`, `brand`, `cached_items`), and so do `lang`, `hw`, `dlpref`, `domainjoined` and `updaters`; the source IP address and the versions sent can still let Google correlate checks. CUP signing of the response and CRX3 publisher-proof and key-hash checks are Chrome's, unchanged. On Helium it also undoes `helium/core/component-updates.patch`: every component registers again (Helium registers only CRLSet, PKI Metadata, the SSL error assistant and Widevine; before 0.22.2 only CRLSet and Widevine, so PKI Metadata never loaded), the update URL is Google's instead of `services.helium.imput.net/com` (which needs onboarding consent Ardia never asks for), and chrome://components loses Helium's "Helium services" error text; and it turns CUP back on (`ConfiguratorImpl::EnabledCupSigning`, which Helium's `reenable-update-checks` turns off; the extension update service reads it too). Since PKI Metadata replaces the compiled Chrome Root Store with any newer one, a root we distrust must also be in `kSPKIBlockList`: that list joins every CRLSet, downloaded or built in ([Blocking a compromised certificate](#blocking-a-compromised-certificate)) | Never while Ardia takes only the security components from Google (the owner's call) |
| `chromium-extension-omaha-attributes.patch` | Google's kill switch for extensions works again: the update check's `_malware`, `_policy_violation` and `_potentially_uws` answers reach `ExtensionService::PerformActionBasedOnOmahaAttributes` and its `OmahaAttributesHandler`, which blocklist (malware: unloaded, "This extension contains malware.") or greylist (disabled) the extension, as in Chrome. It restores what `fix-building-without-safebrowsing` cut with Safe Browsing: the handler in `chrome/browser/extensions/BUILD.gn` and `ExtensionService`, `ChromeExtensionSystem`'s forwarding, `UpdateService::OnCrxStateChange`'s call, and the bodies of `ExtensionRegistrar::OnBlocklistState*`/`OnGreylistState*`. Safe Browsing's own verdict handlers stay cut | Helium's `fix-building-without-safebrowsing` stops cutting the Omaha attributes handler |
| `chromium-extension-management-policy-hook.patch` | Every profile's extension `ManagementPolicy` gets our providers (`ardia::RegisterManagementPolicyProviders`, `ac_scripts_policy.cc`) before it loads any extension: the unpacked "Ardia Scripts" extension at `<data dir>/Scripts/extension` may only hold content scripts (manifest keys, no permissions, plain script files), checked on install, reload, enable and every startup, so a manifest rewritten on disk can't side-load a privileged extension. `ac_extensions_install` of that folder refuses a symlinked folder and, while it runs, any unpacked install from another path; the policy also follows the folder's own extension id, and `ACContentBrowserClient` blocks navigation to any of its pages (`AddScriptsPagesThrottle`) | Never: Ardia feature (the Scripts extension's policy) |
| `chromium-extension-sync-installer-hook.patch` | Tells ArdiaCore which installs are sync installs, per installer: `ExtensionUpdater::CreateUpdateInstaller` calls `g_ardia_sync_installer_created` (profile, id, installer) for a pending install that came from sync, and `CrxInstaller::ReportSuccessFromUIThread` calls `g_ardia_crx_installing` (context, installer, extension) on the UI thread just before it hands the registrar the extension. `ac_extensions_sync_installers.cc` keeps the sync installers until their callback runs, so an install is a sync install exactly when the installer completing it is one of them, and the user's own Web Store install of the same id is told apart from a sync install that was cancelled or is still running (extension sync, `docs/sync.md` › Extensions) | Never: Ardia feature (sync installs told apart per installer) |
| `chromium-unpacked-load-path-hook.patch` | Every unpacked load (install, reload, Chromium's own reloads, `--load-extension`) asks `g_ardia_unpacked_path_allowed` with the path it was given and the path it resolved to, before reading the extension; `ac_scripts_policy.cc` refuses a load that names `<data dir>/Scripts` unless it resolves to exactly the real `Scripts/extension` folder, so swapping that folder for a symlink can't load another extension under its name | Never: Ardia feature (the Scripts folder can't be swapped for a symlink) |
| `chromium-window-docked-devtools.patch` | `DevtoolsUIController::UpdateDevtools` tells ArdiaCore of every change to a tab's docked DevTools (`g_ardia_devtools_dock_changed`). DevTools may dock in any Browser, as in stock Chrome (CEF had turned docking off for every Browser but ArdiaCore's own) | Never: Ardia feature (ArdiaCore shows docked DevTools) |
| `chromium-devtools-redock-display.patch` | A `RenderWidgetHostViewMac` that a `views::WebView` gives up (`SetParentUiLayer(nullptr)`) draws into its own NSView again. Chrome switched it to the Views compositor for good the first time it was attached, so DevTools docked back from their own window stayed blank in the client's view | Chromium gives a `RenderWidgetHostViewMac` its own NSView back when a `views::WebView` releases it |
| `chromium-window-hosted.patch` | Shared half (the Mac's `BridgedContentView.ardiaEmbeddedView` is in `chromium-window-hosted-mac.patch`): a Browser ArdiaCore says so of (`g_ardia_keeps_window_without_tabs`) stays open when its last tab closes, unless the window is closing | Never while ArdiaCore keeps tabless windows open |
| `chromium-window-hosted-mac.patch` | The Mac half of the hosted window patch: `BridgedContentView.ardiaEmbeddedView`, a subview the embedder adds over the widget's views, which hit testing and accessibility ask first while it is visible | Never while ArdiaCore draws its UI over Chrome's window views |
| `chromium-mac-secure-input-window-focus.patch` | A backport of upstream Chromium [998a3a35](https://chromium.googlesource.com/chromium/src/+/998a3a35d72973ec86b288064cd2bc920b646d4b) (CL 8681398) with its regression test: `RenderWidgetHostViewMac` releases Secure Input when a window with a focused password field loses focus | The Chromium we build contains 998a3a35 |
| `chromium-devtools-window-title.patch` | DevTools' title is Dia's, "Developer Tools - <url>" (`DevToolsUIBindings` `kTitleFormat`), so Chrome's own undocked DevTools window says so too | Never: Dia's title, Ardia's choice |
| `chromium-global-trace-id-64bit.patch` | `base::trace_event::GetNextGlobalTraceId()` counts with a 64-bit atomic instead of a 32-bit `AtomicSequenceNumber`, so trace ids don't repeat within a process. The drag gate compares a press's trace id for as long as the press is held | Chromium makes `GetNextGlobalTraceId` 64-bit, or the drag gate stops comparing trace ids |
| `chromium-drag-start-event-id.patch` | Blink tells the browser which press a drag came from. `WidgetBaseInputHandler::HandleInputEvent` makes the `LatencyInfo` trace id of the event it is handling current (`WidgetBaseClient::ExchangeCurrentInputEventId`, read through `FrameWidget::CurrentInputEventId`) and restores the outer event's id when it returns, so nested input (a debugger pause inside a listener) doesn't lose it. `MouseEventManager` records that id whenever it stores a press as `mouse_down_` (a buttonless press, or one `EventHandler` swallows, never gets there). `TryStartDrag` copies that press id into the page's `DragState` before `dragstart`, with whether the event starting the drag came from DevTools (`kFromDebugger`; coalesced mouse moves share their modifiers). `WebFrameWidgetImpl::StartDragging` sends both as `DragEventSourceInfo.press_event_id` and `trigger_from_debugger` and clears them | Chromium tells the browser which press a drag came from itself, or the drag gate goes |
| `chromium-devtools-control-token.patch` | The `ardia` command's control server: a DevTools HTTP handler whose socket factory ArdiaCore claims (`g_ardia_devtools_token_factory`) runs in token mode. Every WebSocket upgrade, browser or page, needs `?token=` (`g_ardia_devtools_token_accepts`, compared in constant time; 403 otherwise) and is routed without its query; `/json*`, `/` and `/devtools/*` answer 404, and so does every other route but `GET /ardia/active?token=`: `{"targetId": …}`, the DevTools page target of the tab the user is looking at in the last focused window, or null for New Tab and Ardia's own pages (the app reports that tab, `ac_cli_control {active}`), since an occluded window's pages all report hidden; Chrome's Host check stays, and before the token is read a WebSocket upgrade or `/ardia/active` is refused when it carries anything only a browser sends (`Origin`, `Sec-Fetch-Site`, `Sec-Fetch-Dest`; not `Sec-Fetch-Mode`, which Node's WebSocket sends) or a `Host` other than `127.0.0.1:<port>` or `localhost:<port>` (`ArdiaRequestIsFromProgram`), whatever `--remote-allow-origins` says; a handshake Chrome's WebSocket code would refuse (version, key) is refused before it counts. The handler reports listening, failing, going away and its connection count (`g_ardia_devtools_token_server`). The owner is `//chrome/browser/ardia` `ac_cli_control.cc` (engine call `ac_cli_control`): one server per start with a new token, published in `<user data dir>/ArdiaControl.json` by `ac_cli_control_file.cc` (0600, written atomically, deleted on stop and at quit; the folder is opened once and checked by descriptor, `UnsafeControlFolder`: a folder you don't own, others can write to, with a macOS access list that allows anyone but you anything, on a volume that ignores ownership (Mac), or on a mount that skips permission checks for other users (Linux: a `fuse`, `fuse.*`, `fuseblk` or `fuseblk.*` mount with `allow_other` and without `default_permissions`, or a `cifs`/`smb3` mount with `noperm`, read for the mount the folder's descriptor is on from `/proc/self/fdinfo` and `mountinfo`; a mount it can't read refuses with its own reason) stops the server with the reason; the temporary file is created, set to 0600, stripped of any inherited macOS ACL and checked, `OnlyOwnerCanRead`, then renamed, all relative to that descriptor, which is kept so the stop deletes the file from the folder it was published in and nowhere else; only the startup cleanup of a previous run's file goes by path), never `DevToolsActivePort`. A start settles only once that file is written (a failed write stops the server and says why), and a write still queued after a stop never lands (its generation check and rename hold the lock a stop takes to revoke it). It stops when the `RemoteDebuggingAllowed` policy turns off, and stands aside when `--remote-debugging-port` runs a server. The app turns off `DevToolsAcceptDebuggingConnections` (`ArdiaHost+Launch.mm`): chrome://inspect's approval mode would swap the process's one handler for its own. **A token client is a full DevTools client of the browser** (`ac_cli_token_policy.cc`, owned by `ac_cli_control.cc`; the owner's decision, #2807, `docs/cli.md`), the same as a `--remote-debugging-port` client: every client of a token server gets an `ArdiaDevToolsTokenClient` (`g_ardia_devtools_token_client`; a token server whose policy is missing refuses every socket), which allows every method, target, URL, browser context and local files (`MayAttachToURL`/`MayAttachToRenderFrameHost` answer yes and the patch no longer overrides `MayReadLocalFiles`/`MayWriteLocalFiles`), and passes events and replies through unchanged. It keeps only the connection's bookkeeping: a command's envelope may hold only `id`, `method`, `params` (an object) and `sessionId`, and its `sessionId` must name a session this client has attached (Chrome answers an unknown session without its `sessionId`, so that reply could never be matched); every command is tracked by (session, id) until its reply, a second command with the same pair is refused before dispatch, the command is dispatched as parsed so Chrome sees the id that was tracked, and past 4096 commands outstanding on a socket (Chrome drops some without a reply, such as a navigation `Page.disable` cancels) the socket is closed with that reason rather than left wedged; a session's entries, and those of the sessions attached through it, go when `Target.detachedFromTarget` reports it gone (Chromium can drop child sessions without an event of their own), and every other id stays reserved until its reply arrives or its session ends (a crash doesn't clear them: Chromium answers most waiting commands itself once the target recovers, `DevToolsSession::ClearPendingMessages`); `Inspector.detached` doesn't end the session (Chromium sends it on a clean renderer exit and keeps the session). Only Target lifecycle events and the replies to `Target.createTarget`, `getTargets` and `getTargetInfo` are parsed: a created tab is recorded as the command's (`ac_cli_owned_tabs.cc`, read by `ac_cli_owns_tab` for the off-screen move) and targets in an automation window get `ardiaOffscreen: true`. The engine never closes a tab itself; the app closes off-screen tabs through ArdiaCore 5 s after the last connection ends (#3663: an engine-side orphan close deleted tabs under live sessions and trapped in a will-deactivate subscriber). Commands are counted by domain for `ac_cli_control`'s status (`tokenCommands`). `g_ardia_devtools_may_attach` and `g_ardia_devtools_may_input` stay in the patch with nothing installing them, so `AttachInternal` and `InputHandler` behave as stock for every client. Every session attach and detach is reported (`g_ardia_devtools_session_attached` at the end of a successful `DevToolsAgentHostImpl::AttachInternal`, `g_ardia_devtools_session_detached` at the start of `DetachInternal`, which every detach path runs): `ac_cli_visible_tabs.cc` keeps a tab that a token client's session is attached to (page, iframe or tab target) visible to its renderer, as a tab capture does (`IncrementCapturerCount` with `stay_hidden` false, no wake lock, not counted as activity), from a task posted after the attach until a task posted at the detach; a hold is keyed by its session and a generation number and reaches the WebContents only through a weak pointer, so a detach that comes first, a reused session address or a closing tab can't leak or double-release it. A DevTools-port client gets the same only in a test instance launched with `--test cdpTabsVisible`. The patch's `RenderFrameDevToolsAgentHost::ReadyToCommitNavigation` still asks each session's `MayAttachToURL` about the URL about to commit; a token client always answers yes. The policy finds a target by id with the patch's `ArdiaDevToolsAgentHostForId`, which reads Chrome's host map without taking a reference, never `GetForId` (#807) | Never: the `ardia` command's control server |
| `chromium-drag-always-ends.patch` | A drag the renderer started always ends. Blink ignores every mouse and key event while it thinks a drag is in progress (`WebFrameWidgetImpl::doing_drag_and_drop_`; compositor scrolling carries on), so a drag the browser never ends leaves the page deaf to clicks and typing until its document goes. Three ways that happened: (1) a DevTools session took the drag (Chrome's emulation of a CDP mouse drag, or `Input.setInterceptDrags`) and went away before releasing it: `InputHandler` now remembers the source widget of a drag it took (`ardia_drag_source_`, set in `StartDragging`, cleared by `DragEnded`) and `ArdiaEndOwnedDrag` ends it (`DragTargetDragLeave` on the widget it entered, `DragSourceEndedAt(kNone)` on the source, so the page gets `dragend`) from `ClearInputState` (`Disable`, which every detach runs, and `SetRenderer`), from `setInterceptDrags(false)` while a handed-over drag is open, and from the destructor; (2) a drag started by DevTools input (`DragEventSourceInfo.trigger_from_debugger`, `chromium-drag-start-event-id.patch`) that no session took, such as one whose `StartDragging` arrives after the session's release, fell through to a macOS drag session with no button down: `RenderWidgetHostImpl::StartDragging` ends it instead; (3) a macOS drag start that is refused never told the renderer: `-[WebContentsViewCocoa startDragWithDropData:…]` returned when `ui::IsDragSessionInitiationAllowed()` said no (a drag session open anywhere in the process, or the run loop tracking events), leaving `drag_source_start_rwh_` set so every later drag in that tab returned early too. It now answers `EndDrag(None)`; `WebContentsViewMac::StartDragging` checks the same permission for an in-process view before it records the drag, and its re-entrant early return ends the new source's drag unless that source is the one dragging (`ArdiaEndRefusedDrag`). A DevTools drag has one owner and ends in the frame it started in. The emulated drag (`InputHandler::DragController`) is taken only by the session whose own press started it (the same press id and `trigger_from_debugger` test token sessions already pass, now for every session) and only when no other handler took it (`*intercepted`), so a session that merely holds a press never owns, or later ends, another session's drag. Its state records the source widget: a drop goes to the widget under the release, and source-ended (`DragSourceSystemDragEnded`, then `DragSourceEndedAt` with the point transformed into the source's view, `ArdiaEndDragSource`) goes to the source, for the release, for a cancel and for `Input.dispatchDragEvent`'s `drop` and `dragCancel`; upstream sent it to the destination, which left the source deaf when a drag crossed between a page and a cross-site iframe. `devtools_instrumentation::DragEnded` now says which widget ended, and a handler keeps its ownership unless that widget is its source. Every drag has an id that its asynchronous steps carry (`DragUpdated`, the hit test before the drop): a reply for a drag that is gone, or for an earlier drag, is dropped instead of touching the current one, and the first update's null callback is no longer dereferenced (a renderer swap during that update crashed the browser). Every terminal step (release, cancel, an end from outside, abandonment: `ArdiaForgetDrag`) invalidates the controller's pending callbacks and bumps the handler's ownership generation, so an unanswered move or release of a finished drag is settled with an error instead of being replayed as a mouse event into the next drag. `Input.dispatchDragEvent`'s `drop` waits for the destination's drag-over reply through the handler's own weak pointer with that generation (`ArdiaDropAfterDragOver`): a reply that arrives after the session detached, or after the drag was ended or replaced, delivers no drop and ends nothing. The handler also remembers the widget an explicit `dragEnter` entered and where (`ardia_drag_entered_`), and sends it `DragTargetDragLeave` on `dragCancel`, on abandonment, when a `dragEnter` or `drop` goes to another widget, so a cross-site iframe doesn't keep a drag that left. An `Input.dispatchDragEvent` command always gets an answer and never strands its drag: its callback travels as a `FailSafe` through the widget lookup, the destination's drag-enter/drag-over wait and the source-ended wait, so a destination or source that goes away answers with an error instead of nothing. The command takes the ownership generation when it arrives and carries it through the lookup and the drop's drag-over wait; a stale one (the drag was cancelled, ended or replaced meanwhile) is refused and touches nothing. A current one whose destination is gone ends the drag it belongs to before answering with the error: the lookup found no widget for a `drop` or `dragCancel`, the destination view vanished before the reply, or the reply was dropped with the destination (a `ScopedClosureRunner` bound into the wait posts `ArdiaCancelDragOfGeneration`), so the source takes input again while the session stays attached. A mouse drag the controller runs and an explicit `dragEnter` can have entered different widgets; every ending leaves both (`DragController::ArdiaLeaveTargets`, skipping the widget that gets the drop). The controller's own drag-over waits carry the same kind of guard, scoped to the drag's id (`ArdiaAbandonDrag`): when the widget a mouse drag is over is destroyed before it answers, the drag is cancelled, so the source gets its ending and a later mouse-up isn't parked behind an update that will never complete. `Input.cancelDragging` cancels whatever the session holds, not only a controller drag: a handed-over drag (`ardia_drag_owned_`) and an explicitly entered widget go through the same cleanup. The controller's entered widget and the explicit one are one record in effect: whichever path leaves a widget clears the other's record of it (`ArdiaLeaveTargets`), an explicit `dragEnter` leaves the controller's widget, and a mouse move back over a widget the explicit path left enters it again, so its drop isn't ignored and no widget is left twice. A controller drop only ever goes to a widget the controller itself entered with its own data. `RenderWidgetHostImpl::DragTargetDrop` has `CHECK_EQ(GetRoutingID(), drop_data->view_id)` (`GrantFileAccessFromDropData`), and upstream dropped on whatever widget was under the release with the data of the widget last entered: a mouse drag in a page released over a cross-site iframe without a move there killed the browser (also on 0.2.46-nightly.7, before this patch). At a release, when the controller's own record doesn't have the widget under it (the mouse never moved there, or an explicit `dragEnter` took the drag elsewhere or entered this widget with other data: `ArdiaExplicitlyEntered` hands the widget's record to the explicit path), the controller enters it with its own data and waits for that drag-over's operation, once per drag; it keeps the chosen widget and its widget-local point through the wait instead of hit-testing local coordinates against the root, uses the release event's own point when the release isn't on the widget of the last move, and cancels the drag with an error if the widget still isn't entered afterwards. A release that arrives while a move's drag-over is still unanswered keeps its own destination view and local point for after the wait too (upstream queued it without them and hit-tested the last move's position, local to the widget it was over, against the root), and the drag is cancelled if that view is gone by then. The point of a release is always the release event's own, which is already local to its widget, also when it is the widget of the last move (upstream reused the last move's point, so a release elsewhere in the same widget dropped where the mouse had been). Owning a drag (`ardia_drag_owned_`) is kept apart from its source still existing: when the source frame was destroyed mid-drag, a release or drop still reaches the destination and a cancel leaves it, but no widget is told its drag ended (`dragsEnded.sourceGone`); only a synthetic drag with no source at all keeps upstream's source-ended to the destination. Each ending is counted by kind in `g_ardia_drags_ended` (`ac_content_hooks.h`), which `ac_cli_control`'s status returns as `dragsEnded` for telemetry (`usage_counts` `stuck_drags_ended_*`). `ui::ArdiaRefuseDragSessionInitiation` makes the permission answer no for the whole run; `ac_seams.mm` calls it for `--test nativeDragRefused`, so `packages/ardiacore/scripts/drag-end-check.mjs` can drive (3) without ever beginning a macOS drag session | Chromium ends a renderer-started drag on all three paths the row names; each hunk goes with its path |
| `chromium-capture-wake-lock-awake-only.patch` | `WebContentsImpl::IncrementCapturerCount` requests the capture wake lock only while a capturer asked to stay awake. Chrome bound the lock on the first `stay_awake` capture and then requested it on every later increment, so after a tab share had ended, a capture that asked for no wake lock (the `ardia` command's visible-tab hold) kept the display awake | Chromium requests the capture wake lock only for capturers that asked to stay awake |
| `chromium-device-emulation-size-reset.patch` | `WebContentsImpl::ClearDeviceEmulationSize` forgets the emulated size also when the page has no view. It returned early then, so a DevTools viewport override (`ardia browse set viewport`) whose renderer crashed before the session detached left `device_emulation_size_` set, and a reload came back at the emulated size for good (`GetSizeForMainFrame`). Only the view's own resize back stays conditional on there being a view | Chromium clears the emulated size when the page has no view |
| `chromium-devtools-find-detach-keeps-selection.patch` | A DevTools session that never used Chromium 156's new `FindInPage` domain leaves the tab's find alone when it detaches. Upstream's `FindInPageHandler::Disable()`, run at every detach, called `StopFinding(CLEAR_SELECTION)` on any tab that had ever run a find, and the renderer's "Unselect" took the caret out of a focused field. ArdiaCore's own sessions (tab pictures through `Page.captureScreenshot`, cookie reads) attach and detach on their own, so after ⌘F a page's script-set caret vanished within seconds. `Disable()` now stops only a find its handler started | Chromium's `FindInPageHandler::Disable()` stops clearing a find the session never started |
| `chromium-neterror-game.patch` | "Where's the lamb?" replaces the dino: the offline page and chrome://game (below) | Never: Ardia feature (its offline game) |
| `chromium-autofill-address-bubble-window.patch` | Chrome's offers to save or update an address (and its address sign-in promo) look the `AutofillBubbleHandler` up on the tab's Browser (`AutofillBubbleHandler::Get` on its unowned user data, as the save-card bubble already does), so they reach ArdiaCore's handler (`ACBrowserWindow::AttachBrowser` registers it): `FindBrowserWindowWithWebContents` finds BrowserViews only. It also carries CEF's `chrome_autofill_bubble_3796`: a tab with no window, or a handler that shows nothing, gets no address or card bubble instead of a crash | Chromium's address bubbles find their handler on the tab's Browser, as the save-card bubble does |
| `chromium-password-generation-local.patch` | Chrome offers "Suggest strong password" without password sync (`PasswordFeatureManagerImpl::IsGenerationEnabled`); generated passwords save to the profile's local store like any other. With no account, its popup says "Passwords are saved to Password Manager on this device." instead of "…saved to Google Password Manager for ." | Chromium offers password generation without password sync |
| `chromium-password-string-erase.patch` | A `PasswordString` that holds its password as a plain `std::u16string` (Chrome's default; the process-bound backing, `kUseProcessBoundPasswordString`, is off) zeroes it, every byte of its capacity, when it is destroyed, cleared or assigned over. Chrome only cleared it, so every saved password a store read decrypted stayed in freed memory, including the results Chrome drops when their consumer has gone (`ConsumerReplyConverter`). Only `password_string.cc` changes, so the header and its ~180 includers don't rebuild. `ac_passwords_logins` (sync's read) refuses to run with the process-bound backing on, since that backing's buffer isn't erased | Chromium zeroes a plain `PasswordString` itself, or turns `kUseProcessBoundPasswordString` on |
| `chromium-os-crypt-decrypt-erase.patch` | `os_crypt_async::Encryptor`'s decrypt paths zero their plaintext temporaries, every byte of their capacity, before they're freed: the byte vector a key decrypts into (`DecryptData`), the string `DecryptString` copies from (it now assigns straight into the caller's string, with no temporary in between) and `DecryptString16`'s UTF-8 copy. What they return is unchanged; cookies and every other os_crypt user decrypt exactly as before. Without it a saved password's plaintext stayed in freed memory twice on every read, before it reached the `PasswordString` that `chromium-password-string-erase.patch` erases | Chromium zeroes `os_crypt_async::Encryptor`'s decrypt temporaries itself |
| `chromium-extension-installed-bubble.patch` | Chrome's "<extension> has been added" bubble (`ShowInfoDialog`): a window without Chrome's toolbar (every client window) gets it as a bubble under the top-right corner of the window, with a close button, closing on Esc and when the window is clicked. Chrome fell back to a browser-modal sheet there, with no buttons and no way to dismiss it. The app renames "Chromium" in Chrome's strings itself (`ac_strings.cc`) | Chromium gives a window without its toolbar a dismissible bubble, or ArdiaCore shows its own |
| `chromium-tab-sharing-capturer.patch` | Each tab-sharing infobar remembers the frame whose capture it's for (`TabSharingInfoBarDelegate::capturer_id()`): a tab shows one infobar per share, and "Share this tab instead" moves only that share, never another call's | Chromium keys each tab-sharing infobar by its capturer |
| `chromium-keep-old-frame-on-swap.patch` | A same-site click swaps the page's view: `RenderFrameHostManager::CommitPending` hides the old view before the new view's `TakeFallbackContentFrom`. ArdiaCore hosts each page's NSView itself, so each page view has its own `BrowserCompositorMac` (Chrome's pages sit in Views layers and never lose theirs), and the hide dropped the old view's compositor, with the frame's `CALayerParams` and the GPU process's `CAContext`, so the new view showed the page's root background until its own first frame (GitHub issue #795). Now `TransitionToState(HasNoCompositor)` keeps a view's compositor that has a frame as `retired_compositor_`, suspended and detached, with a clone of its last `CALayerParams` (`GetLastCALayerParams` answers from it when the view's own compositor has none); a view hidden before its own first frame keeps the one it inherited instead. The new view's `TakeFallbackContentFrom` takes it over for at most 4 s, and its first `CALayerParams` (`AcceleratedWidgetCALayerParamsUpdated`) releases it 50 ms later, after the NSView has the new contents. A retired compositor that no view takes over (a tab switch hides a view the same way) is released after 100 ms, and destroying the view releases it. Measured in `docs/perf/vs-browsers.md` › Same-site link click | Never while ArdiaCore hosts each page's NSView with its own `BrowserCompositorMac`; or Chromium keeps the old compositor until the new view takes its fallback |
| `chromium-keep-compositor-on-occlusion.patch` | A window on another macOS Space is occluded (`WebContentsImpl` hides its page views with `OCCLUDED`, after the 1 s delay in `web_contents_view_cocoa.mm`), and `RenderWidgetHostViewMac::WasOccluded` calls `SetRenderWidgetHostIsHidden(true)` the way a tab switch does, so `UpdateState` moved the page's `BrowserCompositorMac` to `HasNoCompositor` and the view lost its compositor and last frame; on return the page was blank until the renderer drew a new frame (GitHub issue #662). Now `UpdateState` keeps `HasOwnCompositor` when the host is hidden but the view's root layer is still visible, which is the occluded case: the renderer still gets `WasHidden` and stops, but the compositor, the NSView's `CALayerParams` and the locked frame stay (`DelegatedFrameHostIsVisible` stays true, so the frame evictor does not run), and `SetRenderWidgetHostIsHidden(false)` calls `DelegatedFrameHost::WasShown` itself because the state doesn't change. A real hide (`RenderWidgetHostViewMac::Hide`: a tab switch or a closed tab) sets the layer invisible before `WasOccluded`, and `SetViewVisible(false)` runs `UpdateState` for a held compositor, so it retires and releases after 100 ms as `chromium-keep-old-frame-on-swap.patch` made it. Held for at most 10 minutes: every window `[NSWindow isOccluded]` reports (on another Space, minimised or covered by other windows) that has drawn a frame keeps its compositor's GPU memory and the frame's IOSurface (measured 10-30 MB a window) until it returns, the view hides, the page closes, 10 minutes pass (`BrowserCompositorMac::ReleaseHeld`, then the window comes back blank until the renderer draws, as without the hold) or memory pressure starts (a `base::MemoryConsumer`, driven by the browser's `MemoryPressureListenerPolicy`; no compositor is held while the system is under pressure). The hold time is the `hold_for` param of the `HoldCompositorWhileOccluded` feature (`--enable-features=HoldCompositorWhileOccluded:hold_for/5s` for tests; disabling the feature turns the hold off). Trace events `BrowserCompositorMac::HoldForOcclusion`, `BrowserCompositorMac::ShowHeld` and `BrowserCompositorMac::ReleaseHeld` (category `content`). `packages/ardiacore/tests/occlusion-compositor-wiring.test.mjs` pins the wiring | Never while ArdiaCore hosts each page's NSView itself; or Chromium keeps an occluded view's compositor and last frame |
| `chromium-windowless-page-screen-rects.patch` | A tab whose page view isn't in a window (a background tab the `ardia` command or a link opened, before Ardia shows it) tells its renderer the window it belongs to. Stock Chrome on macOS sends a hidden widget no screen rects at all (`RenderWidgetHostImpl::SendScreenRects` returns while `is_hidden_`), and a view without a window counts as headless: `SetBounds` copies the view's own rect into the window frame, so pages read 0x0 at 0,0, or outer equal to inner at 0,1080, until the tab is shown. Now `SendScreenRects` goes ahead once for a hidden widget that has never had a window rect when ArdiaCore says it's a tab's (`g_ardia_hidden_widget_takes_screen_rects`; later moves wait for the tab to be shown, as stock), and `RenderWidgetHostViewMac::GetBoundsInScreen` and `GetViewBounds` ask ArdiaCore (`g_ardia_windowless_page_screen_rects`, `ac_windowless_page.mm`) while the view has no window (`IsHeadless()`) or an empty one: the tab's own window if it's on screen, else the front window showing pages, with the content origin of the page shown there (else the bottom-right corner). So `outerWidth`/`outerHeight`, `screenX`/`screenY` and `innerWidth`/`innerHeight` match the shown tab's from the page's first script, and showing the tab later changes nothing the page can see. A tab outside a Browser (extension pages, DevTools) stays stock. No view moves, so focus, visibility, throttling and dialogs don't change. `ac_cli_control` status reports `windowlessPages {given, missed}` (tabs given a window's geometry, tabs with no window on screen to take it from) | Never while background tabs live outside any window; or Chromium sends a windowless hidden view its window's screen rects |
| `chromium-desktop-capture-window-audio.patch` | A desktop getUserMedia of a window gets audio when its `DesktopMediaID` carries a `window_audio_type` (`ShouldCaptureAudio` in `desktop_capture_access_handler.cc`, which allowed audio only for screens and tabs). Only ArdiaCore's grant sets one (`ac_desktop_capture.mm`, from the share picker's audio checkbox); Chrome's own picker sets it only for getDisplayMedia, which doesn't take this path, so extensions' desktopCapture is unchanged | Chromium allows window audio on the desktop capture path, or Ardia's share picker drops window audio |
| `chromium-video-super-resolution.patch` | Video upscaling on Apple silicon: a per-compositor gate (`RenderWidgetHostView::SetVideoSuperResolutionAllowed` → `BrowserCompositorMac`, kept across its compositors → `ui::Compositor` → `DisplayPrivate.SetVideoSuperResolutionAllowed` → `viz::Display`, which redraws once on a change → `gfx::FrameData`) reaches the GPU process's `ImageTransportSurfaceOverlayMac::Present`, where `CALayerTreeCoordinator::UpscaleVideo` hands the frame's video layers to ArdiaCore's upscaler (`g_ardia_create_video_upscaler`, set in the GPU process; `//ardia/core` `ac_video_upscaler.mm`). A frame whose upscale has just started holds its CA commit until the job completes (at most 0.6 of a display frame, 4–10 ms, posted, never blocking the GPU thread); a later finish replaces the committed layer's contents in a small CA commit, a redraw of the same frame takes the cached output at once, and the contents are a `CALayer`'s IOSurface or an `AVSampleBufferDisplayLayer`'s buffer alike. The browser side decides the gate (`ac_video_upscaling.mm`) | Never: Ardia feature (video upscaling on Apple silicon) |
| `chromium-freeze-spares-live-connections.patch` | Infinite tab freezing (Helium turns `InfiniteTabsFreezing` on) never freezes a page that holds a live connection: a WebSocket, WebTransport or WebRTC connection, or a direct socket with a request outstanding, sticky ones included (`content::ArdiaFrameHasLiveConnection`, `ardia_live_connection.cc`, from the frame's back/forward cache features). Chrome's freeze drops a WebSocket (`DisconnectWebSocketOnBFCache` acts on any freeze), so a chat or mail tab in the background lost its connection at every freeze. Every other freezing rule, and the periodic unfreeze, is Chrome's | Helium stops turning on `InfiniteTabsFreezing`, or Chromium's freeze spares pages with live connections |
| `chromium-memory-saver-pinned-tabs.patch` | Memory Saver's timer puts a pinned tab to sleep like any other tab (issue #1069: Top Apps tiles and pinned rows are Chrome's pinned tabs, and stayed loaded for hours at Maximum). `DiscardEligibilityPolicy` keeps a pinned tab only from an urgent discard (memory pressure), and `MemorySaverModePolicy` starts a pinned tab's timer however often it was revisited (the cap of 5 / 15 / 15 visits would exempt every tile in daily use). Every other protection is Chrome's. The two unit tests that state this are changed with it (`TestCannotDiscardPinnedTab`, `DiscardPinnedTabAboveMaxNumRevisits`) | Never while Top Apps tiles and pinned rows are Chrome's pinned tabs |
| `chromium-embedder-discard-veto.patch` | Mac only. Chrome's discard eligibility asks one hook the embedder sets at startup whether a page may be discarded, so state Chrome doesn't track keeps a tab loaded through every automatic discard (Memory Saver's timer, memory pressure, frozen with growing memory, the loaded tab budget): `g_ardia_keeps_page(const PageNode*)`, defined in `discard_eligibility_policy.cc` with the same shape and name as Windows' `chromium-win-discard-asks-the-host.patch`, asked right after the checks that the page is a loaded tab and before the early answer for an external or frozen-with-growing-memory discard, a vetoed page refused outright as `kOptedOut` and recorded in Chromium's discard histograms. No header changes, so the series base needs no new file. Performance manager depends on no Ardia code; `ac_discard_veto.mm` declares the hook, sets it in `InstallChromeHooks` and vetoes a page whose document came from a form post (`PostedDocument` document user data, set on a cross-document commit in `TabBridge::DidFinishNavigation`, so `pushState` and the back/forward cache keep it), a page whose live frames have a beforeunload handler (read per frame, so an open unload dialog still counts) and a page that started a download still running (`DownloadItemUtils::GetOriginalWebContents`). It also vetoes a tab an `ardia browse` session holds: `+[ArdiaCoreEngine holdTabsForCli:]` (the app's `engine.setCliHeldTabs`, on every hold change) marks those WebContents with `CliHeldTab` user data holding a deadline (the wall-clock time each hold ends, turned into a TimeTicks deadline on arrival and capped at 300 s; a mark past it vetoes nothing) drops the mark from the ones no longer held or whose deadline has already passed, says which tabs it marked, and answers how many held tabs Chromium asked to discard since the last call, each counted once per hold. `-[ArdiaCoreTab sleepIfHiddenFor:]` reports them as 100, 101, 102 and 103 with Chrome's own reasons, read with the veto bypassed (`ScopedDiscardVetoBypass`). An external discard (the tab menu's Sleep Tab) is never vetoed. Its unit test is `TestEmbedderVetoKeepsAllButExternal`. The series line is `mac` and `series-win` skips it, since neither the Linux nor the Windows layer sets this hook (Windows keeps pages through its own patch's), so neither of their keys moves | Never: it is Ardia's own seam for state Chrome doesn't track |
| `chromium-temporary-tab-restore-hook.patch` | A tab ArdiaCore marks temporary (`ArdiaCoreTab.temporary`: the Peek's page, until it becomes a tab) never reaches Chrome's Recently Closed: `TabRestoreServiceHelper::PopulateTab` asks `g_ardia_live_tab_skips_restore` (ArdiaCore: the tab's `SessionID` is in `TabBridge`'s temporary set, or the tab is in an automation window, `docs/cli.md` › The engine's token connection) and records no navigations for it, so the single-tab close, an extension's `tabs.remove` and a window's or group's close all leave it out, and no real entry is evicted to make room for it. A window entry renumbers the tabs it keeps and maps the selected tab into them; when the temporary tab itself was selected, its source (the hook names it) is selected instead, else the nearest kept tab, so `chrome.sessions` reports the right active tab | Never: Ardia feature (Peek and automation tabs stay out of Recently Closed) |
| `chromium-hosted-browsers-no-session-service.patch` | Chrome's `SessionService` tracks no Browser ArdiaCore hosts (`g_ardia_omits_from_session_service`, answered by `ACBrowserWindow::IsOurs`), the ones Chrome creates and ArdiaCore adopts (`chrome.windows.create`) included, as its own already were (`omit_from_session_restore`). Ardia keeps its own session (`session.json`), so after a crash Chrome's last session brings back nothing, a Peek included, into Recently Closed | Never while Ardia keeps its own session (`session.json`) |
| `chromium-angle-metal-shader-cache.patch` | The framework ships ANGLE's prebuilt Metal shader cache (`gpu_shader_cache.bin`) again: Helium applies ungoogled's `fix-building-with-prunned-binaries`, which drops it from `chrome_framework_resources` | Helium stops dropping `gpu_shader_cache.bin` (ungoogled's `fix-building-with-prunned-binaries`) |
| `chromium-ungoogled-disable-default-extensions.patch` | ungoogled's `0005-disable-default-extensions` (BSD), which Helium leaves out, without its `webstore_installer.cc` part (that part stubs out Web Store installs): no Web Store hosted app or in-app payments app among the component extensions | Helium applies ungoogled's `0005-disable-default-extensions` itself without its `webstore_installer.cc` hunk, so Web Store installs keep working |
| `chromium-ungoogled-disable-missing-key-warning.patch` | ungoogled's `0013-disable-missing-key-warning` (BSD), which Helium leaves out: no "Google API keys are missing" infobar | Helium applies ungoogled's `0013-disable-missing-key-warning` itself |
| `chromium-ungoogled-mime-util-ymp.patch` | iridium's `mime_util-force-text-x-suse-ymp-to-be-downloaded` (BSD), which Helium leaves out: YaST one-click files download instead of rendering | Helium applies it itself, or Chromium downloads YaST one-click files |
| `chromium-background-instance-no-default-handlers.patch` | A hidden test instance (`ARDIA_BACKGROUND=1`, which the app passes as `--ardia-background`; ArdiaCore sets `g_ardia_background_instance`) never sets a system default: `shell_integration`'s `SetAsDefaultBrowser`, `SetAsDefaultClientForScheme` and `SetAsDefaultHandlerForUTType` log a line and return false, so chrome://settings' Make default, the default browser prompt or a default protocol handler in a scratch copy can't change the owner's defaults. The app's own Set as Default goes through `ArdiaSystem.setAsDefaultBrowser`, which does the same | Never: hidden test instances must not change the owner's defaults |
| `chromium-apple-passwords-host-skipped.patch` | Native messaging starts Apple Passwords' helper (`com.apple.passwordmanager`) only for a browser process holding `com.apple.developer.web-browser.public-key-credential`. The helper's parent launch constraint accepts any parent with that entitlement (besides its list of known browsers, which doesn't name Ardia) and kills it at exec under any other, which left a crash report at every connectNative of the iCloud Passwords extension once Helium's `scan-chrome-native-messaging-hosts` found its manifest in `/Library/Google/Chrome/NativeMessagingHosts`. A release signed with `Ardia-ICloudPasskeys.entitlements` finds the host; Debug, train and ad hoc builds don't, and `FindManifest` answers "Can't find native messaging host" there | Apple's helper names Ardia among its known browsers, or Chromium checks the entitlement before it launches the helper |
| `chromium-extension-tab-move-closing-window.patch` | An extension's tab move between windows (`chrome.tabs.move` with a `windowId`, `chrome.windows.create` with a `tabId`) fails before anything detaches when either window is closing. Into one running its unload handlers the moved tab would die in its `CloseAllTabs`; into a delete-scheduled one (still in `WindowControllerList`, gone from `GlobalBrowserCollection`) `TabListBridge::MoveTabToWindow` hit `CHECK(target_window)`: "No window with id". Out of a closing one, a `ClosePage` already sent acked into `Close` after the move and closed the tab in its new window: "Tabs can't move out of a window that is closing.", checked in `tabs_util::ValidateTabForMove` (shared by `tabs.move` and `windows.create`, so before `windows.create` makes its window) | Chromium refuses an extension's tab move into or out of a closing window itself |
| `chromium-webstore-icon-optional.patch` | A Web Store install goes on with the default icon when the listing's icon can't be fetched or decoded. Chrome's `WebstoreInstallHelper` fetched the store's lh3.googleusercontent.com icon before the install prompt and ended the install with "Image decode failed" on any DNS, block, Local Network Access, HTTP or decode failure, before the CRX was downloaded (#1135). The failure is logged. | Chromium lets a Web Store install go on without the listing's icon |
| `chromium-enterprise-context-info.patch` | `chrome.enterprise.reportingPrivate.getContextInfo()` answers with the device's context in every build. Helium builds with `enterprise_cloud_content_analysis=false` (ungoogled's `fix-building-without-safebrowsing`), and in such a build `EnterpriseReportingPrivateGetContextInfoFunction::Run` answered with no arguments: the caller got `undefined` and no `lastError`, so Google's Endpoint Verification threw reading `realtimeUrlCheckMode` and never reported the device, which kept Google's context-aware access blocked (GitHub issue #1088, Helium's imputnet/helium#2386). `ContextInfoFetcher` already leaves the content analysis connector fields out when the flag is off, so `Run` now always uses it: affiliation ids, browser version, site isolation, the built-in DNS client, Chrome Remote Desktop blocking, the OS firewall and the system DNS servers, with real-time URL checks and Safe Browsing reported as disabled (ungoogled's `ToContextInfo`). Nothing is sent anywhere: the extension reads it | Helium builds with `enterprise_cloud_content_analysis=true`, or Chromium answers `getContextInfo` without it |
| `chromium-ardia-layer.patch` | The macOS `//chrome:chrome_dll` (ArdiaCore's framework) links `//chrome/browser/ardia` and exports its `ac_*` calls | Never: it links Ardia's own layer |
| `chromium-pip-overlay-window.patch` | Chrome makes our `ArdiaVideoOverlayWindow` (`chrome/browser/ardia/pip/`, a `VideoOverlayWindowViews` subclass with its own buttons, progress bar, fade and bounds memory; the hook makes six methods virtual): Dia's video Picture in Picture window (measured in `docs/dia-spec.md` › Picture in Picture): nothing but the video at rest (the origin shows only with the controls); on hover a 35 % black scrim, back to tab (top left) and close (top right) as 28 pt rounded squares with 1 pt line glyphs (the window can hand each one's frame, hover, press and fade opacity to a presenter set on the NSWindow, `presentArdiaPictureInPictureControls:` in `ac_pip_mac.mm`; the app sets none since its liquid glass was removed (2026-10-29), so Chrome paints them), the origin centred in 13 pt, a bare play/pause glyph between bare ±10 s buttons (Chrome's, restyled; ← and → seek while they show), and a 5 pt progress bar that seeks; no previous/next track, time, mute, captions or minimize controls. The idle fade (Chrome's 2.5 s timer, rebound) skips while the pointer rests on a control. Controls fade in 200 ms ease-in-out. The window shows at once and fades out in Core Animation (100 ms from the close button, 70 ms otherwise, smooth while the tab is being shown), and a new window opens where the last one was left, sized to the new video and kept on screen (`ArdiaPictureInPicture.plist` in the user data dir). Closing it, by its button or by the window going away any other way, never pauses the video, which keeps playing in its tab, as in Dia and Arc (`OnCloseButtonPressed` asks for `kCloseWindowOnly`, and the subclass's `OnNativeWidgetDestroyed` tells the controller not to pause; Chrome paused whenever the window had a play/pause button) | Never: Ardia feature (Dia's Picture in Picture window) |
| `chromium-pip-user-agent-ignores-page-opt-out.patch` | A page's `disablepictureinpicture` stops only its own `requestPictureInPicture()`: the browser still hears the video can go into Picture in Picture (so auto PiP on a tab switch works), and a request from an isolated world (our PiP control's, `ac_content_renderer_client.cc`) or from the browser (Chrome's auto PiP) opens it. YouTube's player sets the attribute on video it doesn't mark backgroundable, YouTube TV's included (#908). The permissions policy still blocks. Adding the attribute while the video is in PiP still closes it; writing it again while it's already set (YouTube's player does on each video it loads) no longer does | Chromium lets user-agent and isolated-world Picture in Picture requests past `disablepictureinpicture` |
| `chromium-auto-pip-global-switch.patch` | Settings' global automatic Picture in Picture switch wins over a site's own setting: with `g_ardia_auto_picture_in_picture_off` (`+[ArdiaCoreEngine setAutoPictureInPicture:]`, `ardiacore_engine.mm`), `AutoPictureInPictureTabHelper::GetCurrentContentSetting` answers BLOCK for every page, a site the user allowed included | Chromium lets a global setting override a site's automatic Picture in Picture setting |
| `chromium-media-session-main-frame-handler.patch` | `content::ArdiaMainFrameHandlesEnterPictureInPicture` answers whether the tab's media session routes `enterpictureinpicture` to the main document's own handler; the manual Picture in Picture control (`ac_page_channel.mm` `EnterPictureInPictureForClick`) takes the media-session route only then, and otherwise asks the page's video element | Never while the manual Picture in Picture control chooses its route per tab; or content exposes the media session's routing |
| `chromium-widevine-without-cdm.patch` | Widevine answers as it does in Chrome on the Mac though Ardia has no Widevine CDM (Google licenses it only to VMP-signed browsers). With `g_ardia_widevine_without_cdm` (set by `ACMainDelegate` in every process) and no Widevine registered, the renderer's key system list gets Chrome's Mac Widevine entry (VP8, VP9, AV1 and H.264, cenc and cbcs, temporary sessions, software-secure robustness), so `requestMediaKeySystemAccess('com.widevine.alpha', …)` resolves with Chrome's configuration; `createMediaKeys()` then rejects with NotSupportedError ("CDM Factory creation failed."), since the browser finds no CDM to start. Apple's online store (`/shop/shld/v3/verify.js`) treats a Chrome user agent whose Widevine probe doesn't resolve as a bot and answers its checkout steps with HTTP 541, a "Page Not Found" (#956). `page_script.js` counts a protected system's refused `createMediaKeys` as a refusal, so a page that then can't play offers WebKit (FairPlay) as before. A Widevine CDM that is registered (none is today) is used as is | Ardia ships Google's Widevine CDM (that needs VMP signing) |
| `chromium-ardia-linux-layer.patch` | The Linux counterpart of `chromium-ardia-layer.patch`: `//chrome` links `//chrome/browser/ardia` and `//ardia/linux`, `ChromeBrowserMainParts` starts the Ardia Linux host (`ardia::StartLinuxHost`), and every process restricts the bundled uBlock Origin (`g_ardia_restricted_component_extension`) as `ACMainDelegate` does on the Mac | Never: it links Ardia's own Linux layer |
| `chromium-linux-action-popup-hook.patch` | `chrome.action.openPopup()` asks the Linux host first (`g_ardia_open_action_popup`), which shows the popup in the shell | Never: Ardia feature (extension popups in the Linux shell) |
| `chromium-linux-settings-overrides.patch` | `chrome_settings_overrides` is available on Linux, so an extension's `search_provider` reaches `search.engines`; its homepage and startup pages aren't applied, since the shell has its own | Chromium makes `chrome_settings_overrides` available on Linux and Ardia's Linux shell takes an extension's homepage and startup pages as well; until both, the patch keeps search provider overrides and drops the other two |
| `chromium-linux-native-messaging-hosts.patch` | When Chromium finds no user-level native messaging manifest, the Linux host may name one (`g_ardia_native_messaging_manifest`), so hosts installed for Chromium (`~/.config/chromium/NativeMessagingHosts`) work | Never while Ardia reads hosts installed for other browsers |
| `chromium-linux-extension-keybindings.patch` | Chromium's extension keybinding registry and action delegates register no accelerators on Linux: the shell dispatches extension commands | Never while the Linux shell dispatches extension commands itself |
| `chromium-linux-document-close.patch` | Closing a tab, a window or the app on Linux goes through the host's close hooks (`//ardia/linux:close_hooks`): the shell may defer or cancel a close (`CanCancelLinuxClose`, close tokens), and each beforeunload reply is matched to the request that asked for it, so a stale reply can't close a window | Never while the Linux shell owns closing |
| `chromium-linux-devtools-authority.patch` | DevTools windows on Linux take leases and tickets from the host (`ac_linux_devtools_authority`): each open, inspect, console and close runs as one tracked operation, so the shell and Chromium agree on which frontend a page's DevTools belong to | Never while the Linux shell hosts DevTools |
| `chromium-linux-auto-pip.patch` | Linux turns on `BrowserInitiatedAutomaticPictureInPicture`, `WebContentsDiscard` and `WebUICodeCache` (V8 keeps the shell's code cache), and automatic Picture in Picture asks the host whether a tab is shown (`g_ardia_linux_tab_shown`), since the shell decides that | Never while the Linux shell decides which tab shows; the feature switches go once Chromium turns them on by default |
| `chromium-linux-pip-placement.patch` | The video Picture in Picture window's widget params go to the Linux host (`PrepareArdiaPictureInPicture`) before it opens, so it opens where Ardia places it | Never: Ardia feature |
| `chromium-linux-page-status.patch` | A tab's hovered link, an unresponsive or responsive renderer and the end of a drag reach the Linux host first (`g_ardia_linux_target_url`, `_renderer_unresponsive`, `_renderer_responsive`, `_drag_ended`), so the shell shows the status bubble and the hang dialog | Never: Ardia feature |
| `chromium-linux-wheel-zoom.patch` | With `g_ardia_linux_wheel_zoom_off`, Ctrl+wheel doesn't zoom the page (`BrowserWebContentsDelegate::ContentsZoomChange`) | Never while Settings offers the wheel zoom switch |
| `chromium-linux-private-links.patch` | A user's open-in-private of a link (`kOffTheRecord`, browser-initiated, with a gesture) asks the Linux host (`g_ardia_linux_off_the_record_navigation`), which opens it in Ardia's private window | Never: Ardia feature |
| `chromium-linux-devtools-open-tab.patch` | A link DevTools opens tells the Linux host which tab it opened (`g_ardia_linux_devtools_opened_tab`), or, with no inspected tab, the host opens it (`g_ardia_linux_devtools_open_url`) | Never while the Linux shell owns tabs |
| `chromium-linux-background-windows.patch` | A Linux background instance (`ARDIA_BACKGROUND=1`, `--ardia-background`) never asks the platform for activation: `BrowserView::Show` maps a hidden window inactive (keeping a saved maximized state) and `Activate` skips the platform activation; on X11 an inactive map sets `_NET_WM_USER_TIME` to 0. The launch environment is read in `BasicStartupComplete`, before Chrome shows its startup window | Never: hidden test instances must not take focus |
| `chromium-linux-companion-browsers.patch` | A Linux window can show tabs of several profiles: the host keeps one hidden companion Browser per other profile, whose widget is never shown (`Show`, `Activate` and the rest go to the host or are dropped), whose tab-modal dialogs and permission prompts the visible window hosts, and which raises no close warning of its own | Never while one Linux window shows tabs of several profiles |
| `chromium-linux-page-agent.patch` | Ardia's page agent runs in every Linux page: its own isolated world (`ISOLATED_WORLD_ID_ARDIA_PAGE`), `//ardia/linux:page_agent` made for each render frame and run at document start, and its browser-side interface bound per frame (`g_ardia_linux_page_host_binder`) | Never: Ardia feature (the Linux counterpart of the page script) |
| `chromium-linux-page-prompts.patch` | Permission prompts, the file system restore prompt, the external protocol dialog, autofill bubbles and the password bubble of pages the shell shows go to the Linux host (`g_ardia_create_permission_prompt`, `g_ardia_file_system_restore_prompt`, `g_ardia_external_protocol_dialog`, `g_ardia_linux_autofill_bubble_handler`, `g_ardia_linux_password_bubble_hidden`), and Chrome's tab-active checks ask which tab the shell shows | Never: Ardia feature |
| `chromium-linux-navigation-hold-hook.patch` | The Linux host adds navigation throttles (`g_ardia_linux_navigation_throttles`), which hold a page navigation for at most 2 s while the shell decides on it; internal schemes aren't held | Never: Ardia feature |
| `chromium-linux-autoplay-policy.patch` | The Linux host may block autoplay per tab (`g_ardia_linux_autoplay_blocked`): a page that would autoplay needs a user activation | Never: Ardia feature (per-site autoplay blocking) |
| `chromium-linux-web-store-uninstall.patch` | An uninstall the Web Store asks for (`chrome.management.uninstall`) gets its dialog from the Linux host (`g_ardia_linux_store_uninstall`) | Never: Ardia feature |
| `chromium-linux-media-player-pip.patch` | content's `MediaWebContentsObserver` lists a tab's Picture in Picture candidates and opens Picture in Picture for one player (`ArdiaLinuxPictureInPictureCandidates`, `ArdiaLinuxRequestPictureInPicture`), for the shell's Picture in Picture control | Never while the Linux shell has its own Picture in Picture control |
| `chromium-linux-shell-above-input.patch` | The shell's WebView sits above the page views and passes input through where a page shows and no overlay covers it: `BrowserView::ShouldDescendIntoChildForEventHandling` asks the Linux host first, for aura's event targeting and drag and drop | Never while the Linux shell draws above the pages |
| `chromium-linux-branding.patch` | Ardia's Linux names: `ardia.desktop` (`ARDIA_DESKTOP` overrides it), `~/.config/ardia` (`ARDIA_CONFIG_HOME`), and PulseAudio's application name | Never: Ardia's Linux names |
| `chromium-linux-wayland-cursor-fallback.patch` | Wayland's cursor position fallback answers a point just outside the union of every window's bounds, not outside the largest window alone, so it can't land inside another Ardia window | Chromium's `WaylandScreen` fallback accounts for every window |
| `chromium-linux-pip-in-window.patch` | The Linux host may make every video Picture in Picture window itself (`g_ardia_linux_video_overlay`: the in-window player), veto or keep automatic Picture in Picture (`g_ardia_linux_auto_pip_allowed`, `g_ardia_linux_keeps_picture_in_picture`) and refuse Document Picture in Picture (`g_ardia_linux_refuses_document_picture_in_picture`) | Never: Ardia feature (the in-window player) |
| `chromium-linux-glass-compositing.patch` | `content::ArdiaLinuxGpuCompositingDisabled` answers whether GPU compositing is off, so the host turns live glass off under software compositing | content exposes that state to `//chrome`, or the Linux shell drops glass |
| `chromium-linux-open-urls.patch` | URLs on a launch's or a second launch's command line go to the shell (`ardia::TakeLinuxLaunchUrls`) instead of Chrome's startup tabs | Never: Ardia feature |
| `chromium-linux-thin-scroll-bars.patch` | `ui::NativeTheme::SetArdiaLinuxThinScrollBars`: Settings' Thin scroll bars apply to the native theme | Never while Settings offers thin scroll bars |
| `chromium-linux-unhandled-key.patch` | A tab hands a key its page left unhandled to the Linux host before the window gets it, so an unhandled Escape closes Peek and Little Ardia windows as on the Mac | Never: Ardia feature |
| `chromium-linux-window-minimum-size.patch` | The Linux host may set a browser window's minimum size, so a Little Ardia window keeps the Mac's 420 by 300 | Never: Ardia feature |
| `chromium-linux-frameless-utility-windows.patch` | Windows the host names through `g_ardia_linux_frameless_app` (Settings, Import) get Chromium's custom frame with no title bar, no window icon and no extra top border, instead of the window manager's title bar beside Ardia's own controls | Never while the Linux host draws its own window controls |
| `chromium-linux-window-state.patch` | The desktop's window-button layout and each window's tiled edges reach the Linux host: GTK keeps the raw `gtk-decoration-layout` (Qt forwards to its GTK fallback), and Wayland reports each change of tiled edges against the last it reported | Never while the Linux shell draws its own window buttons |
| `chromium-linux-borderless-frame.patch` | Where the compositor decorates a window itself (its xdg-decoration answer is server-side, or there is no answer on a tiling desktop), windows the host names through `g_ardia_linux_borderless_frame` get no frame, insets, shadow or corner radius, only a thin resize band when floating, so Chromium's frame doesn't draw inside the compositor's. Each `XdgToplevel` keeps its compositor's last decoration mode and `g_ardia_linux_compositor_decoration_changed` tells the host when it changes; X11 refreshes `_GTK_FRAME_EXTENTS` when the frame is laid out again; and `WindowSizerLinux` tells the host which browsers got Chromium's default size | All of: Chromium itself drops its frame for a window the compositor decorates (by its xdg-decoration answer, and on tiling desktops), tells the embedder when that answer changes, and keeps X11's frame extents current; and the host still learns which browsers got Chromium's default size (`ArdiaLinuxTakeDefaultSizedBrowser`, which lets a borderless window keep the visible default size without changing saved or copied bounds), from an upstream equivalent or a change to the host |
| `chromium-linux-geolocation.patch` | Sites get their location from the Linux host's provider (`OverrideSystemLocationProvider` → `g_ardia_linux_location_provider`: GeoClue, desktop id `ardia`) | Chromium ships a GeoClue location provider on Linux |

Removed, all in git history:

- 2026-11-09, the engine-side speed work (the owner's call: Helium is the base, no engine optimisations of our own):
  `chromium-begin-frame-warm-up.patch` (the `beginFrameBridge` experiment, never turned on),
  `chromium-main-frame-throttle-after-show.patch` and `chromium-main-frame-full-rate-on-input.patch` (with the
  `ThrottleMainFrameTo60Hz` and `UrgentMainFrameForInput` features they repaired, which the app no longer turns on),
  `chromium-battery-saver-full-rate-on-input.patch` (Battery Saver's 30 Hz cap now holds during input, as in Chrome),
  and the unfreeze-interval half of `chromium-thaw-live-connections.patch` (`ardia_unconnected_unfreeze_interval`);
  its live-connection half stays as `chromium-freeze-spares-live-connections.patch`.
- With the move to Helium: `chromium-safe-browsing-off-file-types.patch` and `chromium-background-features-off.patch`
  (Helium's `fix-building-without-safebrowsing`, `disable-history-clusters`, `disable-ad-topics-and-etc`,
  `disable-live-caption-completely` and `disable-outdated-build-detector` leave the same bytes), and
  `chromium-emudhra-distrust.patch` (the owner's call: on Helium, Google's CRLSet and Chrome Root Store updates through
  `chromium-component-updater-security-only.patch` cover eMudhra, as in Chrome).
- 2026-10-15: `chromium-ui-update-before-insert.patch` and `chromium-tab-strip-notify-before-insert.patch` (CEF's guards
  for an embedder that made the Browser a tab's delegate before inserting it; ArdiaCore never does, and an instrumented
  build never hit either guard across popups, `target=_blank`, ⌘-click, `window.open`, session restore, splits and tabs
  moved between windows), `chromium-icloud-keychain-window.patch` (the tab's window is ArdiaCore's `views::Widget`, so
  Chrome's own branch hands iCloud Keychain that window) and `chromium-pip-close-keeps-playing.patch` (now
  `ArdiaVideoOverlayWindow`'s close button and `OnNativeWidgetDestroyed`).
- 2026-10-09, with CEF: `chromium-webview-native-hosted.patch`, `chromium-browser-view-hosted-fullscreen.patch` and
  `chromium-autofill-card-touchbar.patch`, which served CEF's hosted tabs and views-hosted windows. ArdiaCore has neither.
- 2026-10-08: our 18 `cef-*.patch` to CEF's own tree (the CEF runtime's API the app used before ArdiaCore, `CEF_AC_*`).
- After 0.2.19: `chromium-zz-extensions-page-uninstall.patch` (chrome://extensions uninstalled without Chrome's
  dialog), with the hidden chrome:// pages it served.
- 0.2.0: `chromium-context-menu-hosted.patch`, with the hidden "ghost" Browser windows.

## Using it

The app's build (`apps/browser/macos`) stages `out/Release_GN_arm64/Chromium Framework.framework` itself
(`packages/ardiacore/scripts/stage-framework.sh`, under the chromium lock) and embeds it (`embed.sh`). A checkout without a
Chromium tree downloads the prebuilt engine matching its macOS engine key instead (`engine/engine-key.sh --platform
macos`: one hash of every file the framework is built from, which is `engine/` but for the lines of
`engine/patches/series` only for other platforms (`linux`, `win`, `linux,win`; read with `series.py`'s parser), their
patches and layers, and the translation units a `BUILD.gn` lists only under conditions the Mac never takes (`is_linux`,
`is_win`, `is_linux || is_win`, `!is_mac`), plus `apps/browser/assets/offline-game` with its pipeline; a Linux-only change
keeps the key, and Linux has its own, as Windows does (`--platform win`, the inputs `scripts/windows/engine/key-inputs.json`
declares; `docs/engine-build-windows.md`), which adds nothing to the other two; `packages/ardiacore/scripts/fetch-engine.sh`,
published with each release whose engine changed; `docs/releasing.md`). After an engine change, rebuild incrementally
with `scripts/agent/engine-build` and the next app build picks it up. Don't call `autoninja` directly for that: the
script caps siso's parallel jobs by RAM, and siso's defaults ran ~150 mojom generators at once and ran this 32 GB Mac out
of memory (two kernel watchdog panics, 2026-11-11).

## Our hooks in Chrome's code

Where our patches and `engine/ardiacore/apply.sh` let ArdiaCore decide something in Chrome's code, the hook is a
`g_ardia_*` function pointer (or flag) defined in the Chrome file that calls it; unset, Chrome behaves as stock. Each is
declared once, in `//ardia/core`'s `ac_hooks.h` (hooks in `chrome/`) or `ac_content_hooks.h` (in `content/`,
`components/`, `extensions/`, which can't see `chrome/`'s headers), and both the Chrome file (`// nogncheck`) and our
layers include that header (ArdiaCore and `chrome/browser/ardia` through the header-only `//ardia/core:hooks` target), so
a signature that drifts on either side is a compile error, not a crash at the first call.
(Some changes are direct instead: `ChromeMain` making ArdiaCore's main delegate, the PiP window factory, the `CHECK`s made tolerant of a Browser without a `BrowserView`.) ArdiaCore sets the patches' hooks as
the browser process starts (`ACMainDelegate::PreSandboxStartup`), in `ardiacore::InstallChromeHooks` (`ac_seams.mm`: the
browser window factory (H1), reserved and global accelerators, history eligibility, DNR rule matches, the extension
installed bubble, action popups, the password bubble, the extension install prompt, device choosers, media access
requests (`g_ardia_media_access_request` in `MediaCaptureDevicesDispatcher`: a page's screen capture without a click is
refused for every delegate, Document Picture-in-Picture's included), the Cast dialog,
extension side panels, hidden windows, windows without tabs, docked DevTools' changes, the WebContentsDelegate (H2), and
`g_ardia_viewless_browsers`, which apply.sh's toast and reading mode hooks read). Hooks that need a started browser are
installed in one list, `ardiacore::OnEngineStarted` (`ardiacore_engine.mm`: permission prompts, external apps, host
visibility…). `ACMainDelegate` sets the process-wide switches (idle timers, storage, Bluetooth) in
`BasicStartupComplete`, and a few hooks are still set by the object that serves them when it is first made
(`ac_navigation_hold.mm`, `ac_tab_bridge.mm`'s opacity flag, the extension sync installer, the scripts policy, the CLI
control server). A new hook goes into the patch series (`engine/patches/`), not into `apply.sh`, and is installed in
`InstallChromeHooks` unless it needs a started browser.

`apply.sh` also adds H1–H6, which stand where CEF's patches had seams ArdiaCore used. "Is this Browser ours" is
`WindowHost::ForBrowser`: ArdiaCore's record (`ac_browser_window.h`), made when a Browser gets one of ArdiaCore's
`ACBrowserWindow`s and dropped when its `ACWebContentsDelegate` goes in `~Browser`, after the window.

| Hook | Where | What | Replaces |
|---|---|---|---|
| H1 | `browser.cc` | With `g_ardia_browser_window_factory` set, a Browser may take the host's own `BrowserWindow` (`params.window`) without `CHECK_IS_TEST` | CEF's removed `CHECK` |
| H2 | `browser_window_features.cc` `InitPostWindowConstruction` | `g_ardia_create_web_contents_delegate` makes ArdiaCore's `BrowserWebContentsDelegate` for its Browsers | `cef::BrowserDelegate::CreateWebContentsDelegate` |
| H3 | `permission_prompt_factory.cc` | `g_ardia_create_permission_prompt` | `SetCreatePermissionPromptFunction` |
| H4 | none: `ACContextMenu` (`ac_context_menu.mm`) overrides `RenderViewContextMenuMacCocoa::Show()` | in background mode the menu goes to the host, not the screen | `RegisterMenuShowHandlerCallback` |
| H5 | `chrome_main_delegate.cc` | `g_ardia_resource_bundle_delegate`, passed where Chrome inits the shared ResourceBundle | CEF's `GetResourceBundleDelegate()` |
| H6 | `chrome_main_delegate.cc`, `chrome_browser_main.cc`, `chrome_browser_main_mac.mm`, `chrome_content_browser_client.cc`, `chrome_browser_policy_connector.cc` | `g_ardia_embedder` (set by `ACMainDelegate` in every process) skips at run time what `chrome_runtime.patch` compiled out under `ENABLE_CEF`: `InitializeUserDataDir` and startup metrics, `RecordCoreSystemProfile`, crash keys, the crash reporter and crashpad; `StartupBrowserCreator::Start` and the `RunLoop` (not a no-op under `--no-startup-window`: it sets up profiles and Chrome's own main `RunLoop`); `AppController` and `BuildMainMenu`, `didEndMainMessageLoop`; the `HandleWebUI` handler pair (it rewrites `chrome://` URLs and claims them as WebUI, so it isn't a no-op either). First run and `--make-default-browser` need no hook: `ACMainDelegate::BasicStartupComplete` gives the browser process `--no-first-run` (so `IsChromeFirstRun()` is false), `--no-default-browser-check` and `--no-startup-window`, and drops `--make-default-browser`. And no platform policy provider (`CreatePlatformProvider`), as CEF made none without a policy id: the macOS one's first load ran on the main thread before `BrowserMain`, waiting for `/usr/bin/profiles`, 10–20 ms of every launch | `chrome_runtime.patch`'s `#if !BUILDFLAG(ENABLE_CEF)` blocks; `chrome_browser_policy.patch`'s `CreatePlatformProvider` |

apply.sh also has two hooks for idle wakeups:
- `cpu_health_tracker.cc`: with `g_ardia_skip_cpu_health_sampling`, `CpuHealthTracker` gets no `CpuProbe`, so there's
  no 15 s CPU sampling. That sampling only feeds Chrome's performance-intervention toolbar button.
- `disk_space_memory_pressure_evaluator_mac.cc`: with `g_ardia_disk_space_check_seconds`, free disk is checked at that
  period while more than 20 GiB are free, and at Chrome's 5 s otherwise.

`ACMainDelegate::BasicStartupComplete` sets the first two (60 s) and turns on
`PartitionAllocAdaptiveMemoryReclaimInterval`. HangWatcher stays on.

`settings_storage_quota_enforcer.cc`: with `g_ardia_lazy_storage_usage` (set by `ACMainDelegate`), a write that ignores
the quota (an extension with `unlimitedStorage`, or sync) and any `remove` or `clear` go straight to the store while
usage hasn't been counted yet, instead of first reading and re-serializing every stored value to count it. The count is
still made, from the store as it is then, when something needs it (`getBytesInUse`, a quota-checked write). When
such an op finds a corrupt value and deletes it (`VALUE_RESTORE_DELETE_SUCCESS`), it runs once more, as the scan's
deletion used to let it succeed. uBlock
Origin keeps ~30 MB in `chrome.storage.local`, and its first write of a session (its request counts, ~4 minutes after
launch) cost ~180 ms on a performance core.

Two hooks take uBlock Origin's content scripts off a restored page's request (set by `ACMainDelegate`):
- `extension_user_script_loader.cc`: with `g_ardia_script_loader_ready_at_once`, a loader made once the extension system
  is ready starts loading at once instead of posting a task first (Chromium's own TODO, crbug.com/415850597). At launch
  that posted task waited behind the early window.
- `user_script_listener.cc`: with `g_ardia_scripts_wait_at_response`, a navigation whose URL a content script wants waits
  for the scripts at `WillProcessResponse` instead of `WillStartRequest`, so its request overlaps the wait and the
  scripts still reach the renderer before the document commits.

`bluetooth_adapter_mac.{h,mm}` and `bluetooth_low_energy_adapter_apple.{h,mm}`: with `g_ardia_bluetooth_poll_on_demand`
(set by `ACMainDelegate`), the Mac Bluetooth adapter polls IOBluetooth every 500 ms only while a discovery session runs.
Otherwise it polls once when something uses the adapter (any call that initializes it: `IsPowered`, `GetDevices`, a
scan…), when CoreBluetooth reports a power or permission change, and when a device connects, never sooner than
500 ms after the last poll. Chrome polls for as long as anything holds the adapter, and a page with a pending WebAuthn
request (Google's sign-in page asks for passkeys as soon as it loads) holds it through `BleAdapterManager` once the
app has the Bluetooth permission: each poll asks `bluetoothd` for the paired devices over XPC, ~2 % of a core (on a
background worker in 155; Chromium 156 polls on the UI thread again), for as long as the tab is open.

`v2_discovery.{h,cc}` and `authenticator_request_dialog_model.cc`: with `g_ardia_hybrid_scan_on_demand` (set by
`ACMainDelegate`), the hybrid (caBLE v2) discovery listens for a phone's BLE advert only while some request's sheet shows
the QR code or a phone connecting (`kCableV2QRCode`, `kCableV2Connecting`, `kCableV2Connected`), or while it has contacted
a linked phone, instead of from the moment a request starts. Chrome starts it with every request once the app has the
Bluetooth permission, a conditional (passkey autofill) one included, so a sign-in page left open scanned for as long as it
was open, and the scan kept the adapter's 500 ms poll running. The scan stops again when no sheet shows those steps; the
request itself and its other transports are untouched.

## The offline page

Wherever Chrome would start the dino (`LocalizedError::IsOfflineError`: `ERR_INTERNET_DISCONNECTED`, or a DNS
probe that ends in `DNS_PROBE_FINISHED_NO_INTERNET`; main frames only; not with `--disable-dinosaur-easter-egg`),
`NetErrorHelper` serves `IDR_ARDIA_GAME_HTML` instead of `neterror.html`: the game from
`apps/browser/assets/offline-game`, one self-contained document (3.8 MB, brotli in `resources.pak`: CSS, scripts and
manifest inline, every WebP a `data:` URL, a CSP that allows exactly those inline blocks by hash). Its
`<script type="application/json" id="game-error">` block gets `{code, url}` of the failed load, which the game reads as
`window.GAME_ERROR`. Every other error keeps Chrome's page. A DNS probe that turns the page offline after it loaded
swaps the game's document in (`document.write`), where Chrome's page would start the dino. The page runs as Chrome's
error page, so Retry is `errorPageController.reloadButtonClick()` and the best score is Chrome's easter-egg high
score (`trackEasterEgg` / `updateEasterEggHighScore`).

The page paints itself in the tab's profile colour: the app sets `-[ArdiaCoreTab pageColor]` (WebView `pageColor`),
ArdiaCore sends it to each main frame as it is created (`ACPage.SetPageColor`, before the frame's first commit) and
again on change, and the renderer sets `window.ardiaPageColor` (and fires `ardiapagecolor`) in error pages only,
before their own scripts; web pages never see it. game.js recolours the backgrounds on a canvas as the New Tab mark is
recoloured, from `offline-game-pipeline/tint_maps.py`'s maps (`assets/bg-map`, 35 KB) and per-scene statistics.

`chrome://game` (the app's `ardia://game`) is an alias of `chrome://dino`: a simulated `ERR_INTERNET_DISCONNECTED`
whose page plays the game on its own, without the offline header. Tabs, popups and side panels share the renderer, so
all of them show it.

The resource file is generated, not patched in: `game-resource.sh` runs
`apps/browser/assets/offline-game-pipeline/inline.py` (Python standard library only) into
`components/neterror/resources/game/game.html` of the Chromium tree. `apply-chromium-patches.sh` and step 5 run it,
and `scripts/agent/engine-build` runs `inline.py` itself (it rewrites the file only when it changed), so every build ships the game folder as it is; `AC_REPO` (in `env.sh`, default the checkout `env.sh` is in, or
`~/Documents/ardia` for the step scripts' copy in `~/chromium-build/scripts`) says where the checkout is. The sprites stay at the art pipeline's 400 px: at the default zoom the front rows already draw them at
about 1:1 on a 2x screen, so 256 px sprites (about 1 MB) would be visibly soft.

## Nothing writes into the app bundle

The signature seals every file in `Ardia.app`, so the app must never write there: one added file and
`codesign --verify --deep --strict` fails ("a sealed resource is missing or invalid"), and an app on a read-only
volume or run translocated can't be written at all. A background run of a signed build, with pages, PDFs, the offline
page, chrome://settings, chrome://extensions, chrome://components and uBlock's own pages, then a diff of the bundle,
found one writer (2026-09-25):

- **declarativeNetRequest indexes next to the extension.** An extension's static rulesets are indexed into
  `<extension>/_metadata/generated_indexed_rulesets/_ruleset<N>`, a path Chrome derives from the extension's folder
  (`FileBackedRulesetSource::CreateStatic`). The ruleset checksums live in the profile's prefs, so a profile with none
  (every new profile; component extensions are never "installed") indexes again, and so does any profile whose
  indexes go stale (a new indexed format in a Chrome update). Shipping prebuilt indexes wouldn't stop the writes.
  So `ArdiaContentBlocker.mm` loaded uBlock Origin Lite from a writable copy in the data directory
  (`<data dir>/Built-in Extensions`). Ardia 0.1.0 loaded uBOL straight from the bundle: its first launch wrote the six
  indexes into the bundle, and from a read-only bundle nothing was blocked at all. Its successor, full uBlock Origin
  (MV2), has no DNR rulesets, and Chrome writes nothing into its folder, so it loads straight from the signed bundle
  (`Contents/Resources/Extensions/ublock`); a copy in the data dir was code any same-user process could edit. The
  first launch of a build that loads it from the bundle deletes the old `Built-in Extensions` folder.

Everything else Chrome writes (component updater, caches, extension installs) goes to the user data dir, and
`MacAppCodeSignClone` is disabled (`ArdiaHost+Launch.mm`). `scripts/release.sh` launches the exported app once and verifies
the signature again, so a new writer fails the release.

## ArdiaCore's layer: `//ardia/core`

ArdiaCore (`docs/ardiacore-spike.md`) is our own layer over Chrome. `engine/ardiacore/apply.sh` copies `engine/ardiacore/src` to
`//ardia/core` and adds its hooks: in files only Chrome's framework compiles (`chrome/BUILD.gn`'s macOS
`chrome_dll`, `chrome/app/chrome_main.cc`), H1–H6 ([above](#our-hooks-in-chromes-code)), and a few `CHECK`s made
tolerant of a Browser without a `BrowserView` (`read_anything_side_panel_controller.cc`, `sad_tab_controller.cc`…).
Run `apply.sh` again after anything that resets these files (steps 1–4). Each hook is one `hook "$src/<file>"` block that
names its own markers, lines only that edit writes: `apply.sh` skips a block whose markers are all in the file, refuses one
that is partly there, and `apply.sh --check` runs every block and names each hook whose markers or header include are
missing. `series.py check` doesn't replace it: it runs `apply.sh` itself, so a hook skipped in the tree is skipped in its
copy too. Changing or removing a hook means restoring its file from the series (`series.py check --keep <dir>` writes
the expected files) before `apply.sh` runs again.

The engine reads no environment variable. The app turns its launch variables into switches (`ArdiaLaunchConfig`
`engineSwitches`: `--ardia-background`, `--ardia-data-dir`, `--ardia-downloads-dir`, `--ardia-switches`, and
`--ardia-test`/`--ardia-trace` in a test instance), and `//ardia/core:launch_switches` (`ac_launch_switches.{h,cc}`,
also used by `chrome/browser/ardia`) reads them: `BackgroundInstance()`, `InstanceValue()`, `SwitchOn()`,
`Traced()` and `TestValue()`/`TestFlag()`. Test and trace values count only past one gate, `TestInstance()`: the browser
process of a build not signed for distribution, on `--use-mock-keychain`, whose `--user-data-dir` is
`--ardia-data-dir`/Chromium. It is decided once, at startup, for test and hidden instances only (a normal launch never
checks its signature), and logs once when it ignores `--ardia-test` or `--ardia-trace`.

## Our own code in the tree: `chrome/browser/ardia`

New engine code is plain Chromium code in new files. It lives in
`//chrome/browser/ardia`, calls Chrome's services directly (`PasswordStoreInterface`, `PersonalDataManager`,
`ExtensionRegistrar`, `HostZoomMap`, `TemplateURLService`, `HistoryService`…) and is exported as plain C from Chrome's
framework.

- **Where it lives.** `engine/chromium/src` mirrors `chromium/src`; `engine/chromium/apply.sh` copies it in
  (`--check` reports drift). This is ArdiaCore's convention too (`engine/ardiacore/src` → `//ardia/core`). Edit the
  repo copy only; `apply.sh` replaces the tree's.
- **Chromium's files we replace.** A file under `engine/chromium/src` outside `chrome/browser/ardia` replaces
  Chromium's at the same path (`apply.sh --paths` lists them; `series.py` counts each as the layer's). Only Chromium's
  logo, by Ardia's (exported by hand from the icon's source, `docs/brand/ardia/README.md`): binary files a patch can't carry. Linux builds read
  their window icons from `chromium/linux/` and `default_100_percent/chromium/linux/` instead, so
  `engine/ardiacore-linux/apply.sh` copies the same logos over Helium's there on every series apply. What it copies
  from outside its own `src` is listed once, in `engine/ardiacore-linux/copies.tsv` (`<source><TAB><target>`), which
  the Linux engine key reads too.
- **How it links.** One `source_set("ardia")` in `chrome/browser/ardia/BUILD.gn`: add your
  `ac_<domain>.cc` to its sources (sorted) and its deps. A header only when another file calls into the domain
  (`ac_tab_restore.h`, `ac_scripts_policy.h`, `ac_external_apps.h`…); exports need none. `//ardia/core` depends on
  this target, so ArdiaCore includes those headers through a real GN dependency.
  `chromium-ardia-layer.patch` links it into the macOS `//chrome:chrome_dll` (ArdiaCore's framework), through the
  `:exports` group that exports `_ac_*`.
- **The C surface.** `public/ac_engine.h` is plain C with the rules: exports are `ac_<domain>_<verb>`, all with one
  signature `void (const char* profile_dir, const char* args_json, ac_engine_reply_t reply, void* context)`; JSON
  object in, JSON object out (`{"error": …}` on failure); UI thread only; the reply runs once, maybe before the
  call returns. Events go to one sink (`ac_engine_set_event_sink`) as `("<domain>.<what>", {profile, …})`.
  `ac_engine.h` has the C++ side: `AC_PROFILE_CALL(name, …)` defines an export whose body gets a resolved
  `ardia::Call& call` (args parsed, profile found; the export has already replied with the error otherwise),
  `AC_ARGS_CALL(name)` one that needs no profile (`ardia::ArgsCall&`), and `Reply`, `Emit`, `StateFor`, `TabWithId`.
  Args are cleansed when the call ends; a call taking secrets passes `ardia::Sensitive{max_bytes}` and reads them with
  `call.SecretAt`. A private window's call carries `offTheRecord: true`; `Call` refuses it ("no engine data for a
  private profile") unless the call passes `ardia::OffTheRecord::kAllow`, so the engine is the one place that says which
  calls serve a private session.
- **The WebKit replica calls** (`ac_extension_mirror.cc` and its siblings) serve the WebKit copy of an extension,
  natively from Swift (`WebKitExtensionShared.swift`), and take `offTheRecord` (`OffTheRecord::kAllow`): a spanning
  extension's private-window copy reads its regular profile's state, as Chrome's own storage and alarms do. A call for a
  private window (an off-the-record profile, or `incognito: true` from the base profile) is refused unless the extension
  is allowed in private windows (`extensions::util::IsIncognitoEnabled`).

  | Call | Reads or writes |
  |---|---|
  | `ac_extension_storage_{get,get_keys,set,remove,clear,get_bytes_in_use,set_access_level}` | `StorageFrontend` for `local`, `sync`, `session` (and `managed`, read-only), with `storage_api.cc`'s rules: a defaults object for `get`, the 25 MB `get` cap, each area's access level for content scripts (`content: true`), which `set_access_level` sets for any area, as Chrome 158's `setAccessLevel` does |
  | `ac_extension_storage_watch` | which extensions' changes go out as `extensions.storageChanged` `{id, area, contentMayRead, changes}` |
  | `ac_extension_alarms_{create,get,get_all,clear,clear_all}` | `AlarmManager`, with `alarms_api.cc`'s validation, 500-alarm cap and minimum delay; `create` answers `{kept: true}` and leaves the alarm alone when one with that name and the same `periodInMinutes` already runs; a private window's call for an extension in split mode is refused (`alarms of an extension in split mode aren't shared with private windows`), since Chrome gives that copy its own alarms |
  | `ac_extension_alarms_watch` | which extensions' alarm firings go out as `extensions.alarm` `{id, alarm}` (`AlarmManager::OnAlarm` hook), for the original profile only |
  | `ac_extension_grants_get` | live active, withheld and optional permissions (`PermissionsData`), and `extensions.grants` on every change (`PermissionsManager::Observer`) |
  | `ac_extension_grants_request` | grants optional permissions and withheld hosts (a single site included) with `permissions_api.cc`'s rules: `UnpackPermissionSet`, nothing outside the manifest, file patterns only with file access, enterprise policy (`IsPermissionSetAllowed`), and Chrome's `PERMISSIONS_PROMPT` (Ardia's prompt) unless the new permissions carry no warning or the extension is a component; after the prompt it grants only to the same loaded extension it asked about |
  | `ac_extension_dnr_{get_dynamic_rules,get_session_rules,get_enabled_rulesets,watch}` | as `declarative_net_request_api.cc` reads them; changes go out as `extensions.dnrChanged` `{id, kind}` |
  | `ac_extension_dnr_{update_dynamic_rules,update_session_rules,update_enabled_rulesets,update_static_rules,get_disabled_rule_ids}` | `RulesMonitorService`, with `declarative_net_request_api.cc`'s rules: the API's own argument parsing, Safe Browsing told of added rules, unknown ruleset ids refused, enabling winning over disabling, nothing done for an empty update; `get_disabled_rule_ids` answers every manifest ruleset at once as `{rulesets: {id: [ruleIds]}}` |

  An engine without them answers `{"error": "the engine has no …"}` (`ArdiaEngineBridge`), and the WebKit copy keeps
  its own storage, alarms, grants (from the Preferences file) and rules, as before.
- **The app** includes `public/ac_engine.h` from the repo and looks each export up with `dlsym` on the engine
  framework (`packages/ardiacore/ios/ArdiaEngineBridge.mm`). A missing export aborts: the app bundles an engine it wasn't built
  for. Add each new call to `docs/ardiacore-parity.md`.

## The patch series

`engine/patches/series` is the one place that says what goes into the tree and in what order: `chromium <patch>`
lines (on the tree step 3 leaves: Helium's series, its domain and name substitution and our renaming; applied in
step 4), then `layer <dir>` lines (our own files,
`<dir>/apply.sh`). Each patch is made against the tree as every line above it leaves it, and covers one concern, named
for it. A new patch goes where it belongs in the file; names no longer carry the order.
A new patch also gets a row in the [table above](#building-the-engine-from-source) (a `series-win` line, in
[docs/engine-build-windows.md](engine-build-windows.md#windows-only-patches)), with what it does and when it can be
removed. `engine/patches/build/tests/test_patch_docs.py` fails when a patch has no row, a row has an empty Removable
when, or a row names a patch the series no longer has. It sits outside the engine key, and the rows live in `docs/`,
so writing them moves no key.

`engine/patches/series.py` does everything with it:

- `apply`: applies the series to the tree, skipping what is applied (step 4 runs it, through
  `apply-chromium-patches.sh`).
- `capture-base`: records every file the series touches as it is before the series (the base). Step 4 runs it
  just before it applies the series, so a fresh or rebased checkout records its own. When the checkout moves to
  another Chromium version, `01-sync.sh` sets the old one aside as `<base>.<old version>`
  (`retire-series-base.sh`). It lives in `~/chromium-build/series-base` (`AC_SERIES_BASE`).
- `check`: copies the base to a scratch directory, applies the whole series there strictly (`git apply`: exact
  context, no fuzz; each layer's `apply.sh` with `CHROMIUM_SRC` pointed at the scratch copy) and compares every
  touched file with the tree, byte for byte. Exit 0 means the series reproduces the engine we build; otherwise it
  lists each step that no longer applies and each file the series doesn't reproduce (an edit made in the tree but
  not in a patch, or the reverse), and keeps the scratch copy for `diff -u`. It writes nothing else and needs no
  lock.
- A file the series starts touching later (a new hook) needs its base too: run `capture-base` before the hook
  first goes into the tree. On an applied tree that's safe: it only records files the base lacks, never one a patch
  creates. `apply` dry-runs each patch first and refuses one that is partly in already, instead of applying its other
  hunks twice. Until then `check` takes the checkout's git HEAD for it and says so, which is right only when nothing
  upstream changes that file.
- `materialize --until <patch> <dir>`: the touched files as the series leaves them after one line. To remake a
  patch, materialize the line above it, edit a copy, and diff.
- `files`: what each line touches.

Run `check` after any patch change, before committing it. For a nightly run on this machine (a local launchd job;
nothing remote is set up), point a LaunchAgent at it, for example `~/Library/LaunchAgents/com.ardia.series-check.plist`
with `ProgramArguments` `/usr/bin/python3`, `<repo>/engine/patches/series.py`, `check`, a
`StartCalendarInterval` of 03:00 and `StandardOutPath` `~/chromium-build/logs/series-check.log`. A CI machine
needs only the repo plus a copy of the base and the tree's touched files: `CHROMIUM_SRC` and `AC_SERIES_BASE` say
where they are.

### The series base archive

`series.py check` needs a whole Chromium tree. CI has none, so each builder's base is published: the files the
platform's series reads (each patch's sources, renamed, copied and mode-only ones included), as step 3 left them, in
`series-base-<chromium>-<helium12>-<platform>-<helium-platform12>-<cpu>-<inputs12>-<rev12>.tar.xz` on the prerelease
`series-base-<chromium>-<helium12>`, with a `.sha256` and a manifest of each file's sha256. `helium12` is
helium-chromium's commit and `helium-platform12` helium-macos's or helium-linux's. `inputs12` is the digest of what
step 3 reads from the repo: `03-helium.py`, `ardia_namesub.py`, `ardia_resources.txt` and every source it lists,
`domsub-keep-store.txt`, `helium-pins.ini`, `env.sh` and `target_config.py`. `rev12` is the digest of the files the
archive holds and of its provenance (the step-3 run and capture it came from), so a re-pack, even of identical files,
never replaces an archive an older checkout pins. `scripts/engine/series-bases.tsv` pins
one archive per platform and CPU, by those pins, that digest and its sha256.

`scripts/engine/series-zero-fuzz.py` works out the pins and the input digest from the checkout, fetches the matching
archives (at most 64 MB each, cached in `~/.cache/ardia/series-base`), checks the table's sha256, then unpacks each one
under size and entry limits (every byte the tar parser reads counts, headers included; the xz decoder may use at most
128 MB), with every file checked against the manifest. It refuses an archive whose manifest lacks the builder's
provenance: every pack check, the step-3 run id, the stamp's sha256 and the capture record's sha256. It applies the series to each archive in a
scratch directory: every `chromium` line with `git apply` and its exact context, every `layer` line with its
`apply.sh`. A `git apply` warning fails its step too (a mode change on a file with another mode applies with only a
warning). It fails when no archive matches the pins and inputs ("the pins moved", or "step 3's inputs changed"), when
the archive lacks a file the series reads (it names the file), and when a hunk needs fuzz (it names the patch, its
series line, the file and the hunk). A hunk that lands at an offset from its header fails when it does so on every
platform that applies the patch. A patch for both platforms can sit exactly on only one when platform-only steps shift
its file (`chromium-cef-carryover`, `chromium-helium-context-menu-cast` and `chromium-freeze-spares-live-connections`
on 158).

The Engine series workflow (`.github/workflows/engine-series.yml`, gated like the builds) runs it on Ubuntu for both
platforms. It runs on every change to `engine/patches`, `engine/chromium`, the layers' `apply.sh`, `copies.tsv` and
the files it copies (`scripts/engine/tests` checks the list), and `scripts/engine`. It passes `--offsets warn
--strict-since` the commit the change starts from: a pull request's base, or a push's previous head, which must be
fetchable or the run fails. A patch the change edits must land exactly, and the 67 patches that already land at an
offset on 158 are listed as warnings. `series-zero-fuzz.py --refresh-offsets` rewrites those hunks' headers and nothing
else, after which every hunk lands exactly on at least one platform. It then checks both platforms again and keeps the
rewrite only if the series still produces the same files on each, so no hunk moves to another identical context. That moves both engine keys, so it goes in with
the next engine build; after that the workflow can drop `--offsets warn`.

**Re-pack the base on every Chromium or Helium move** (a new `CHROMIUM_VERSION` in `env.sh` or a new commit in
`helium-pins.ini`) and **on every change to a step-3 input**, after the builders' trees have run step 3 with it. Until
then the workflow fails. Re-pack too when the series starts reading a file the archive lacks (a new hook): the checker
names it. A base is captured once per step-3 run, so that re-pack also starts from a fresh tree (step 3, capture,
step 4); the base can't be topped up later. On each builder, after step 4 and from a full checkout of the commit the tree was built from (the Linux
layer copies files from `packages/`), run:

    scripts/agent/locked chromium --take <you>
    python3 scripts/engine/series-base-pack.py pack --platform mac --dest <scratch dir>
    scripts/agent/locked chromium --release <you>

Use `--platform linux` on the Linux builder, and set `AC_CHROMIUM_BUILD` for a tree outside `~/chromium-build`. Pack
is read-only on the tree. It refuses unless:
- `chrome/VERSION` is the pinned Chromium;
- both Helium checkouts exist, are clean and sit at the pinned commits;
- the tree's `.helium-stages-src` marker names this tree's inode and shows every mutating step-3 stage for the platform;
- one full `run-step3.py` run did that step 3: its stamp (`.ardia-step3-src.json` beside the tree) names the same tree,
  platform and marker, and its input digest is this checkout's;
- `run-capture.py` captured the base after that run: its record (`.ardia-capture.json` in the base) names that stamp's
  sha256, and every file in the base has exactly the sha256 and mode it recorded, with none missing or added. Pack
  reads the base once, checks that snapshot and archives the same snapshot, then reads the base again and fails if
  anything changed meanwhile;
- every `ardia_resources.txt` resource is byte for byte in the base (or in the tree, when the series doesn't touch it);
- `ardia_namesub.py --check-only` finds no Helium left in the tree's strings;
- `series.py check` reproduces the tree from the base.

It records those checks in the manifest. A change to any step-3 input after step 3 ran (including `03-helium.py`'s logic
and `domsub-keep-store.txt`, which can't be read back from a tree) makes the checkout's digest differ from the stamp's,
so pack refuses until step 3 runs again on a fresh tree. Neither wrapper writes or deletes anything before its child
runs, and both pass the child's exit code and output through. A child that fails its own checks therefore leaves the
stamp and record as they were. One that fails after starting work changes the stage marker or the base, so the old
stamp or record no longer matches and pack refuses. `run-step3.py` writes a stamp only after a single full run on a
fresh tree exits 0 with plain arguments (no `--only`, `--from` or `--no-brand`) and the same input digest before and
after; any other run that changes the tree deletes the stamp, for good: start again from a fresh tree. `run-capture.py`
hands series.py the tree and base it resolved and captures once per stamp. It refuses when that stamp already has a
capture (a marker beside the tree records it, so deleting the base doesn't undo it), when the base already holds
files, and when the tree already carries any series step (engine/chromium's layer directory, or a patch that
reverse-applies), so bytes from after step 4 can't enter the base. It records the stamp's sha256 with every file's
sha256 and mode. The archive and the checker handle a patch that renames, copies or only changes the mode
of a file, but `series.py` (`capture-base`, `check`) reads only `+++` lines. Such a patch needs `series.py` to learn
those headers first, which moves both engine keys: until then `capture-base` doesn't record its source and the
packer's `series.py check` fails on it. Copy the three files
to a machine where `gh` is signed in (a Boat VM's isn't) and run `python3 scripts/engine/series-base-pack.py publish
<archive>`. It refuses an archive without that provenance (`--no-verify`) or for other pins or inputs than the
checkout's, creates
the prerelease if needed, uploads the files (one already there must match), and writes the row into
`series-bases.tsv`. Commit that row with the pin or input change.

## Blocking a compromised certificate

CRLSets and Chrome Root Store updates reach the engine from Google through the component updater
(`chromium-component-updater-security-only.patch`), as in Chrome. When a compromised CA can't wait for them, it goes
into the engine itself. That was done once, for eMudhra on 2026-10-21 (`chromium-emudhra-distrust.patch`, in git
history; dropped with the move to Helium, since Google's updates cover it). Download the certificates into their own directory and,
working from outside it, compute each one's SHA-256 and SPKI SHA-256 with openssl
(`openssl x509 -noout -pubkey | openssl pkey -pubin -outform DER | openssl dgst -sha256`). Check the SPKIs against
an independent published list (Go's `distrustedSPKIHashes`, Mozilla's OneCRL entries). Add the SPKIs to
`kSPKIBlockList` in `net/cert/cert_verify_proc_blocklist.inc`, without comments, and add the PEMs and a README
section to `net/data/ssl/blocklist`. One SPKI covers every cross-sign of the same key. `CRLSet::Parse` merges
that list into every CRLSet, the built-in one included, and `CertVerifyProcBuiltin` checks it against every
certificate of every valid path, locally trusted anchors too. A compromised root goes on the list by its SPKI
as well. If Chrome removes the root, also take it out of `root_store.textproto` and its PEM out of
`root_store.certs` (`root_store_tool` fails on an unused certificate). Leave `version_major` alone: Chrome
applies a component root store only if its version is strictly greater, so a bumped number freezes out
Google's real updates. Put the patch in the series (capture its files' base first), build with `engine-build`,
then check the result in a hidden instance on a train build with CDP. The bad hosts must fail and ordinary
sites must still load. A host whose root is gone fails as `ERR_CERT_AUTHORITY_INVALID` before the blocklist is
consulted, so check the blocklist itself with `engine-build --as <you> cert_verify_tool`, then
`out/Release_GN_arm64/cert_verify_tool --impls=builtin,pathbuilder --no-system-roots --roots=<root PEM>
--hostname=<host> --no-net-fetcher <served chain>`. Expect `ERR_CERT_REVOKED` from builtin and a valid path from
pathbuilder, which doesn't read CRLSets.

## Rebuilding

Everything lives outside the repo in `~/chromium-build`, which carries `.metadata_never_index`.
The step scripts are copied in `engine/patches/build/`, and each expects `~/chromium-build`. Each refuses to run
without `--apply` and the chromium lock (`scripts/agent/locked chromium`); `--help` prints its usage. Run them in the
order 1, 3, 4, 2, 5 on a fresh checkout (`gn gen` once the tree is patched). Run step 3 as one full
`scripts/engine/run-step3.py --apply` run (same arguments as `03-helium.py`), then `scripts/engine/run-capture.py`
(same arguments as `series.py capture-base`) before step 4, both under the chromium lock. The first stamps the inputs
step 3 read, the second records the base it captured. A series base can be published only from a tree and base made
that way ([The series base archive](#the-series-base-archive)).
Helium's checkouts are
`~/chromium-build/helium` and `~/chromium-build/helium-macos` (`HELIUM_DIR`, `HELIUM_MACOS_DIR`), at the commits
`helium-pins.ini` names.

A second tree can live beside the live one (the move to Chromium 158 was built in `~/chromium-build-158` while main
kept building 157 from `~/chromium-build`): set `AC_CHROMIUM_BUILD` to its root, `CHROMIUM_SRC` to its
`chromium_git/chromium/src` and `AC_LOCK_ROOT` to a directory of its own, so its chromium lock is separate from the
live tree's. Every step script, `series.py`, both `apply.sh` and `engine-build` follow those three. `03-helium.py`
then needs `--work`, `--domsub-cache` and `--report` pointed inside that root (its defaults for a tree that isn't the
live one are in a temp dir). Seed it with copy-on-write clones of `depot_tools` and `src/.git` from the live tree
(`cp -c -R`; reading the live tree needs no lock) and fresh clones of Helium's repos, then run step 1: it fetches the
tag at depth 1 and clones every dep fresh (32 GB, 12 min on 2026-11-18).

The live tree in `~/chromium-build` has been Helium's since 2026-10-23 (0.2.40-nightly.5's framework), on Chromium 156 since 2026-10-25, on 156.0.8078.79 (Helium 0.20.3) since 2026-10-31, on 157.0.8103.38 (Helium 0.21.1) since 2026-11-09, and on 157.0.8103.50 (Helium 0.21.2) since 2026-11-12.

| Step | Script | Time (M5 Pro, shared machine) |
|---|---|---|
| 1. Fetch Chromium's tag (`CHROMIUM_VERSION` in `env.sh`) at depth 1 and check it out, then `gclient sync --no-history` of its deps for the Mac with the PGO profiles (`checkout_pgo_profiles`), then its hooks; on a version move, sets the old series base aside first | `01-sync.sh` | ~40 min, 30 GB (deps alone, re-cloned: 7 min; 3.5 min for 156 on 2026-10-25, every git dep deleted first) |
| 2. Write `out/Release_GN_arm64/args.gn` from `gn_defines.sh`, then `gn gen` | `02-gn-args.sh` | 5 s |
| 3. Helium, as Ardia takes it ([Helium](#helium)), in stages: `pins` (the checkouts are at the pinned commits, unmodified and made for this Chromium, and `deps.ini` downloads nothing we don't leave out), `guard`, `patches` (Helium's series, then helium-macos's, minus the skip list, with no fuzz), `fixups`, `domsub`, `namesub`, `brand-namesub`, `version`, `resources`. It runs once per tree: `.helium-stages-src`, beside the tree, records the stages that ran and refuses a second run or one that died mid-stage. Each patch's result goes to `~/chromium-build/logs/helium-patches.tsv`. Run it through `scripts/engine/run-step3.py`, then `scripts/engine/run-capture.py`, so the base can be published | `03-helium.py` (`scripts/engine/run-step3.py`) | 2.5 min (2026-10-25: the patches 15 s, the substitutions and resources 2 min) |
| 4. Our series: `apply-chromium-patches.sh` (`series.py capture-base` and `apply`: the patches, then the layers `engine/chromium/apply.sh` and `engine/ardiacore/apply.sh`) | `04-series.sh` | seconds once every patch applies |
| 5. Regenerate the offline page (`game-resource.sh`), compile `chrome_framework` (ArdiaCore; the app's build stages it from `out/Release_GN_arm64`) | `05-build.sh` | first build 2.5 h (official, ThinLTO, PGO; 2026-10-18), 2 h for 156 at siso's full parallelism (2026-10-25: 1 h 51 min of compiling, then 7.5 min to the linked framework; free memory never under 59 %), 2 h 24 min for 157 to its first compile errors (2026-11-09), then 11 min to the linked framework once they were fixed; incremental: the compile, then a ThinLTO relink of the framework, about 7 min (its cache, `thinlto-cache`, keeps that short) |

After a build, `helium-check-build.py` (read only) checks the framework and its paks for what we leave out of
Helium: it fails if Helium's uBlock Origin, its onboarding page or the non-free search engine data were built or
packed, or if the binary or a pak names a Helium host (`helium.computer`, `imput.net`, `services.helium`).

Disk: about 45 GB in total. That's 40 GB for the checkout with its 13 GB out dir, the PGO profiles (170 MB) and
0.2 GB for the domain-substitution cache.

Rules for editing the tree after the first build:

- **GN args** live in `gn_defines.sh`, the complete list (the args CEF's `gn_args.py` used to merge in are there
  too): an official build (`is_official_build=true`, which turns on ThinLTO and stripping) with PGO
  (`chrome_pgo_phase=2`, the profile `chrome/build/mac-arm.pgo.txt` names), no DCHECKs, no symbols, proprietary
  codecs, Widevine (DRM still needs Google's VMP signing), Ardia branding, and the flags Helium's `flags.gn` sets,
  except `enable_mdns=false` and `enable_service_discovery=false` (the Cast dialog finds devices through them).
  Helium's release build has `symbol_level=1`, for its crash reporter; we have none. `enable_rlz=true` keeps
  Widevine's storage id (`chromium-helium-rlz-for-cdm-storage-id.patch`). Official builds
  don't allow `chrome_enable_logging_by_default`, so Chrome writes no `chrome_debug.log` unless it's started with
  `--enable-logging` (a test instance: `ac launch … --switch --enable-logging`).
  After changing them, run step 2 again.
  - **`alternate_cdm_storage_id_key` never changes.** Widevine's storage ids hash it, so a new value loses every
    user's licences.
  - `treat_warnings_as_errors=false`, `fatal_linker_warnings=false` and `clang_use_chrome_plugins=false`: the SDK
    is newer than Chromium expects, so warnings never fail the build.
  - `enable_background_mode`, `enable_downgrade_processing`, `enable_resource_allowlist_generation`, `enable_rlz` and
    `optimize_webui` are the values CEF's `tools/gn_args.py` used to merge in, as the shipped builds had them.
  - `branding_file_path` is Ardia's bundle and team id, for the passkey and payments keychain access groups;
    product names stay "Chromium" (`chromium-branding.patch`).
- **Moving to a new Chromium version.** Helium tracks Chromium, so from now on a new Helium tag is a new Chromium
  version. It deletes `out/` and costs a full build (official, ThinLTO, PGO), so it needs the owner's OK.
  1. Domain substitution doesn't need reverting: its cache never matches a tree our series has patched (the revert
     fails on the hashes). Set `domsubcache.tar.gz` aside instead, and reset every repo of the checkout to its
     commit (`git reset --hard` and `git clean -ffd` in `src` and through `gclient recurse`). `01-sync.sh` runs
     `gclient sync --reset --force -D` too. Set `.helium-stages-src` aside as well: step 3 refuses a tree whose
     stages it has recorded.
  2. Set `CHROMIUM_VERSION`, `HELIUM_TAG` and `HELIUM_MACOS_TAG` in `env.sh`, and the version, tags and commits in
     `helium-pins.ini`, and check those commits out in `~/chromium-build/helium{,-macos}`. Helium's patches and
     lists are made for exactly one Chromium version: step 3's `pins` stage fails unless `env.sh`, the pins, Helium's
     `chromium_version.txt` and the tree agree.
  3. Delete `out/`, re-run `01-sync.sh`, then steps 3, 4, 2 and 5.
  4. `src` is an unmanaged, shallow solution. gclient never moves it to a new tag, and a plain `git fetch` of it
     (or of a shallow dep) asks for the whole history of every branch: the server builds that pack for an hour
     without sending a byte. So `01-sync.sh` fetches the tag itself at depth 1. If deps stall the same way
     (`STALL DETECTED`, `git fetch --prune --no-tags origin` at 0 % CPU), delete the dep checkouts listed in
     `.gclient_entries` and sync again: gclient clones them fresh at depth 1. On the move to 156 the existing deps
     fetched their whole history at full bandwidth (packs of over two million objects); deleting every git dep
     checkout first and syncing again took 3.5 minutes in all, so do that up front.
  5. Step 3's `guard` stage fails when a skipped patch has left Helium's series (check what replaced it) or an
     applied one now touches what a skip protects (Safe Storage, password saving, Sparkle, the product dir, mDNS);
     `GUARD_ALLOWED` in `03-helium.py` lists the hits reviewed for 0.19.4 (unchanged through 0.22.2). A patch that no longer applies without
     fuzz fails `patches`, and names any skipped patch that shares its files.
  6. Our patches and the hooks may need their context refreshed; `series.py check` and `apply.sh --check` say
     which. A patch whose file moved is rewritten for the new path, and the new path's file goes into the series
     base (`series-base/`) as steps 3 and 4 left it.

## Helium

[Helium](https://github.com/imputnet/helium-chromium) is built on ungoogled-chromium. Step 3 (`03-helium.py`) applies
helium-chromium 0.22.2's series and then helium-macos 0.22.2.1's, as `patch -p1 -l -N` with no fuzz (Helium allows 2).
Helium's build-time downloads (its uBlock Origin, the onboarding page, the non-free search engine data) are never
fetched, and the hunks of its patches that edit them are left out.

**Skipped** (`SKIP` in `03-helium.py`; each is a leaf, so the rest of the series applies without it):

| Patch | Why |
|---|---|
| `helium/core/disable-password-manager` | forces password saving and passkeys off as managed prefs; Ardia uses Chrome's password manager |
| `helium/ui/remove-autofill-link-to-password-manager` | drops "Manage passwords" from the fill dropdown |
| `ungoogled-chromium/fix-building-without-mdns-and-service-discovery` | empties `DnsSdDeviceLister`; the Cast dialog needs mDNS |
| `helium/macos/change-keychain-name` | renames the Safe Storage item; every user's passwords and cookies are encrypted with "Ardia Safe Storage" (`chromium-safe-storage-name.patch`) |
| `helium/macos/change-product-dir-name` | moves the fallback product dir to `net.imput.helium` |
| `rebel/macos/sparkle-integration`, `helium/macos/updater/{fixup-sparkle-glue,sparkle2-integration,disable-default-updater}` | Sparkle inside the framework; the app has its own updater |
| `helium/ui/crash-dialog` | a startup infobar asking to upload crashes to `crash.helium.computer` |
| `helium/core/use-system-python3`, `helium/core/rbe-nativelink-config`, `helium/macos/rbe-linux-clang-wrapper` | Helium's build setup (`.gn`'s `script_executable` would rerun every action; its remote build) |
| `helium/macos/chromium-signing` | Helium's signing flow; `scripts/release.sh` signs Ardia |
| `helium/core/pins/{pin-state,pin-sync,sync-splits,sync-drags,hibernate-on-close,pinned-url,open-links-outside,migrate-legacy-pins}`, `helium/ui/pins-ui` | Helium 0.22.2's shared pinned tabs and their tab-strip UI; Ardia keeps its own pins in the sidebar |

The `guard` stage checks, before anything is applied, that every skipped patch is still in Helium's series and that no
applied patch's added lines touch what a skip protects, beyond the reviewed hits in `GUARD_ALLOWED`. Some patches
can't be skipped because later ones build on them (`proxy-extension-downloads`, `spoof-extension-downloader-platform`,
ungoogled's `disable-webstore-urls` and `fix-building-with-prunned-binaries`, Helium's uBlock patches); our series
undoes what they do instead (below).

After the patches, `fixups` turns saving passwords, addresses and cards back on by default (inox's
`modify-default-prefs` turns them off); autosign-in stays off.

**Substitutions**, in this order:

- `domsub`: Helium's domain substitution, minus the Web Store and extension-updater sources in
  `domsub-keep-store.txt`, so chromewebstore.google.com, clients2.google.com and clients2.googleusercontent.com work.
  Everything else on Helium's list stays substituted. The pre-substitution copies go to
  `~/chromium-build/domsubcache.tar.gz`.
- `namesub`: Helium's `name_substitution.py --sub` and `i18n_apply.py`, unchanged: Chromium becomes Helium in the
  strings, chrome:// becomes helium://, and the translations follow.
- `brand-namesub`: `ardia_namesub.py` runs Helium's machinery again with our rules over every `.grd`, `.grdp` and
  `.xtb`: "The Helium Authors" goes back to "The Chromium Authors" (first, so "Die Helium-Autoren" becomes "Die
  Chromium-Autoren"), Helium becomes Ardia, helium:// shown to the user becomes ardia://, and links inside strings go
  back to chrome:// so they keep opening in the engine. It fails if any string still says helium or imput.
- `version`: `HELIUM_*` lines in `chrome/VERSION` equal to Chromium's own version, so Helium's version never shows.
- `resources`: Helium's icons (its generated ones made with `sips`), then `ardia_resources.txt` over them: Ardia's
  logos and product icons (`engine/chromium/src`, `engine/patches/build/ardia-icons`) and Chromium's own favicons
  for its internal pages (`engine/patches/build/chromium-originals`).

`chromium-helium-branding.patch`, first in our series, covers the literals in source these can't reach, and
`ac_strings.cc` renames "Helium" as well as "Chromium" in Chrome's strings at run time.

**Helium's services stay inert.** They sit behind Helium's services pref and its onboarding consent, and Ardia never
gives that consent: the onboarding page isn't built and the browser always starts with `--no-first-run`. On top of
that, the branding patch makes `ShouldAccessServices` false whatever the prefs say and points every services URL at an
unresolvable placeholder, and the update feed and crash upload URLs are empty. Nothing in the engine contacts a
Helium host; `helium-check-build.py` fails a build whose binary or paks name one.

**What our series undoes** (each patch is in the table above):

- `chromium-webstore-direct`: Web Store installs and extension updates go straight to Google again, not through
  Helium's proxy.
- `chromium-extension-updates` and `chromium-component-updater-security-only`: the extension and component updaters
  check Google's servers (Helium leaves their URLs empty), every component registers again, the component updater
  fetches only CRLSet, PKI Metadata and the SSL error assistant, and CUP is back on.
- `chromium-helium-ublock-off`: Helium's uBlock Origin component isn't built or loaded; Ardia runs its own
  (`fajbdaomknpkicfjcpipdmcpoamdmilh`).
- `chromium-helium-onboarding-off`, `chromium-helium-services-page-off`: no onboarding page, no services page in
  Settings.
- `chromium-helium-search-assets-off`: no non-free search engine assets.
- `chromium-helium-bangs-off`: Helium's native !bangs never fetch.
- `chromium-helium-web-push-off`: Helium's web push (0.22) never connects to its push server and its driver is never
  built.
- `chromium-helium-translate-providers-off`: Helium's translation providers (0.22) can't be used; Translate stays hidden.
- `chromium-helium-ntp-third-party`: chrome://newtab is the third-party New Tab page again unless Google is the default
  engine.
- `chromium-helium-context-menu-cast`: the page menu keeps Cast….
- `chromium-helium-rlz-for-cdm-storage-id`, `chromium-angle-metal-shader-cache`: what Helium's applied ungoogled
  patches took that we need (Widevine's storage id input, ANGLE's Metal shader cache).

**Local history is kept in full.** Helium's applied ungoogled patch `add-flag-to-disable-local-history-expiration`
(with Helium's `history-expiration-threshold` on top) lets the `keep-old-history` switch stop Chromium's 90-day expiry
pass and its refusal of older visits when rows are added. `ac_main_delegate.cc` appends the switch to the browser
process, so an imported Arc history keeps its old pages and the app reads up to `MAX_HISTORY` of them.

**Privacy defaults we inherit.** Where Helium's defaults differ from our ungoogled build's, Helium's win: Secure DNS is
Chromium's automatic mode (ungoogled's `doh-changes` isn't applied; Helium's `dns-providers` adds providers to the
upgrade table), WebRTC uses `default_public_interface_only` (`webrtc-default-handling-policy`), FedCM is on, and EV
certificates show as in Chrome (ungoogled's `disable-fedcm-by-default` and `Remove-EV-certificates` aren't applied).
Helium also adds fingerprinting noise (canvas, audio, hardware concurrency), reduced Accept-Language headers, a Global
Privacy Control pref (off by default) and flags for ECH and QUIC v2, and turns `InfiniteTabsFreezing` on by default.
HTTPS-First in its balanced mode turns itself on by default (`HttpsFirstBalancedModeAutoEnable`): Helium's
`prefer-https-by-default` did that until Chromium 157 made it the default. Inox's prefs, Safe Browsing compiled out (`safe_browsing_mode=0`), MV2 and no
field trials are as before.

**Ungoogled patches Helium leaves out that we carry**, as `chromium-ungoogled-*` patches (BSD-3-Clause, as we
applied them before Helium): `0005-disable-default-extensions` (without its `webstore_installer.cc` part),
`0013-disable-missing-key-warning` and iridium's `mime_util-force-text-x-suse-ymp-to-be-downloaded`. Others Helium
leaves out stay out, as before: `disable-download-quarantine` (Chrome quarantines every download itself, with
`com.apple.quarantine` and its source URL in `kMDItemWhereFroms`), `prefs-always-prompt-for-download-directory`
(Chrome's default, save to Downloads without asking, is Ardia's) and `enable-extra-locales`.

### Tracking upstream

The pins live in four files that have to agree: `env.sh` (`CHROMIUM_VERSION`, `HELIUM_TAG`, `HELIUM_MACOS_TAG`,
`HELIUM_LINUX_TAG`), this folder's `helium-pins.ini` (macOS and Linux), `scripts/windows/engine/helium-pins.ini` and
`scripts/windows/engine/prebuilt.json` (its `chromium`, and its `source`, a full commit). `scripts/engine/upstream-pins.mjs --check`
fails, offline, when one is missing or malformed (versions and tags are dotted numbers, commits full hashes) or when
they disagree on the Chromium version, the helium-chromium tag or commit, or a platform tag that isn't a release of the
pinned helium-chromium; its test runs it in every pull request (Checks, "repository, vouch and stale tests"). Bump
them in one pull request.

The Upstream pins workflow (`.github/workflows/upstream.yml`) runs every Monday and compares the pins with the latest
published releases of helium-chromium, helium-macos, helium-linux and helium-windows and with `chromium_version.txt` at
the newest helium-chromium release, with Chromium stable from chromiumdash as context. The published Windows engine
gets its own line: the helium-windows that `helium-pins.ini` pins at `prebuilt.json`'s `source` commit, held to the
newer of our pin and upstream's, so a Windows engine not yet rebuilt after a bump (as in
[engine-build-windows.md](engine-build-windows.md#helium-for-windows)) reads as behind. While anything is behind it
keeps one issue up to date: one github-actions[bot] opened, with a marker in its body, whatever its labels (opened
labelled `todo`, reopened with a comment if closed). Once nothing is behind it comments once and closes it. Issues
and comments by anyone else are never matched, even when they quote the marker. Pin files that disagree, a value it
can't read, or a page of issues it can't reach exit 1 and change no issue; a GitHub rate limit stops it cleanly. Each
step is checked against the bot's own comments, so a run that failed halfway is finished by the next one without a
repeated comment. Run it locally with `GITHUB_TOKEN=$(gh auth token) node scripts/engine/upstream-pins.mjs` (add
`--issue --dry-run` with `GITHUB_REPOSITORY` to see the issue plan; real writes come only from the workflow), or
dispatch the workflow with `dry_run`. The script and the workflow sit outside every engine key.

### 0.21.1 → 0.21.2 (Chromium 157.0.8103.50, 2026-11-12)

A Chromium patch release, through Helium 0.21.2 and helium-macos 0.21.2.1. What changed in Helium, and what we did:

- **Series.** Added `helium/core/omnibox-suggestions` and `helium/settings/omnibox-suggestions-settings`; removed
  `helium/settings/update-search-suggest-text` (folded into the new settings patch). They add two local profile prefs,
  `helium.omnibox.autocomplete.history_enabled` and `…bookmark_enabled` (both on by default), that Chrome's own
  autocomplete providers check, and an "Address bar" section in chrome://settings/search with those toggles. No host,
  no network change. Ardia's command bar doesn't use Chrome's autocomplete, so the prefs change nothing in the app.
  helium-macos only bumped its pin. `flags.gn`, `flags.macos.gn`, `deps.ini` and the resources are unchanged.
- **Skips and guards.** Every `SKIP` entry is still in the series and still a leaf; the `guard` stage finds the same
  four reviewed hits; 354 patches applied with no fuzz and 14 skipped; `domsub-keep-store.txt` keeps the same 16 store
  files.
- **Our series.** Every patch and both layers applied strictly, unchanged; `series.py check` reproduces all 298
  touched paths.
- **Build.** `out/` was kept (a patch release in the same milestone): 55,800 steps, about 2 h 15 min, most of it
  recompiling for the new PGO profile; no compile errors. `helium-check-build.py` passes with the same 9 resources
  naming Helium.
- **Checked in a hidden instance.** chrome://version and `/json/version` say 157.0.8103.50; a page loads; uBlock
  blocks Google's ad script; chrome://settings/privacy shows no Helium text; chrome://settings/search shows the new
  section branded Ardia ("Ardia sends what you type…"); Quit exits cleanly with no crash report.

### 0.20.3 → 0.21.1 (Chromium 157.0.8103.38, 2026-11-09)

A new Chromium milestone, through Helium 0.21.1 and helium-macos 0.21.1.1. What changed in Helium, and what we did:

- **Series.** Removed: `upstream-fixes/wasm-interpreter-fixes` (V8 157 reads the memory size with `memory_size(0)`
  itself, and `DeclaresLocals` is gone from the scope iterator), ungoogled's `disable-tos-dialog` (it only flipped
  Linux's `eula_required`; Chromium 157 defaults it to false outside Chrome branding, and the Mac never had a ToS
  dialog) and `helium/core/prefer-https-by-default` (Chromium 157 turns `HttpsFirstBalancedModeAutoEnable` on
  itself, so HTTPS-First's balanced mode stays the default). Added: `helium/core/disable-actions-for-browser-commands`,
  which turns `kUseActionsForBrowserCommands` back off (157 turns it on). With it off, `BrowserCommandController`
  makes the classic `CommandUpdaterImpl`, as on 156, so `chrome::ExecuteCommand` from ArdiaCore's command
  dispatcher, context menus and tab commands takes the path it always has; on, it would build a
  `CommandActionUpdater` over `BrowserActions`, which ArdiaCore's browsers don't drive. The rest is Helium's refresh
  for 157 (its settings, layout and new tab page work, which only Chrome's own `BrowserView` shows) and a longer
  domain substitution list. helium-macos only refreshed context. `flags.gn` and `flags.macos.gn` are unchanged,
  `deps.ini` only bumps Helium's uBlock Origin (never fetched), and no patch adds a host.
- **Skips and guards.** Every `SKIP` entry is still in the series and still a leaf, the `guard` stage finds the same
  four reviewed hits, `domsub-keep-store.txt` keeps the same 16 store files, and both resource lists copy 56 files.
- **Our series.** Fourteen patches no longer applied strictly. Context only: `chromium-side-panel-hook`,
  `chromium-component-updater-security-only`, `chromium-extension-omaha-attributes`, `chromium-extension-window-hidden`,
  `chromium-helium-ublock-off`, `chromium-video-super-resolution` (`Display`'s `visible_` is a `DisplayVisibility`
  now), `chromium-temporary-tab-restore-hook` (`BrowserClosing` returns the new entry's id) and
  `chromium-helium-onboarding-off`. Rewritten for 157: `chromium-helium-branding` and
  `chromium-helium-services-page-off` (Settings' privacy page is Lit now: the services row is an `@click` binding and
  its handler is `protected`), `chromium-media-access-hook` and `chromium-thaw-live-connections` (157's
  `CHECK_CURRENTLY_ON` and plain `CHECK`s where 156 had `DCHECK`s and `NotFatalUntil`),
  `chromium-hidden-window-current-window` (`GetCurrentWindowController` tolerates a controller without a
  `BrowserWindowInterface`; the hook asks only when there is one) and `chromium-extension-tab-move-closing-window`
  (157 moved the tab move and its validation out of `tabs_api.cc` into `tabs_util.cc`, shared by `tabs.move` and
  `windows.create`; both checks now live in `tabs_util::MoveTabToWindow` and `ValidateTabForMove`, and
  `tabs_util.cc` joined the series base).
- **Hooks.** In `engine/ardiacore/apply.sh`, the Clear Browsing Data hook follows the code into 157's
  `NotifyBrowserViewCustomEvent` helper, and the external protocol dialog hook's anchor is 157's
  `CHECK(web_contents, …)`. `engine/chromium/apply.sh` applied unchanged.
- **GN.** Chromium 157 deleted the `//chrome/browser/ui:ui` monolith (its sources are split into leaf targets under
  `//chrome/browser`), so `//ardia/core` and `//chrome/browser/ardia` drop that dependency; both already depend on
  `//chrome/browser`.
- **What the compiler found.** `chromium-cef-carryover`'s child-modal focus hunk takes `const auto&`: 157's
  `child_windows_` holds `raw_ptr`. `engine/ardiacore/apply.sh`'s `ChromeMainDelegate` hook: 157 moved
  `InitializeCrashKeys()` alone into `BasicStartupComplete`, so the old gate, which ran from it to the next renderer
  `#endif`, swallowed 157's new `command_line` there; it is now a plain `if (!g_ardia_embedder)` around that call, and
  the old gate starts at `ChromeCrashReporterClient::Create()` in `PreSandboxStartup` and covers the same crash
  reporter and data dir setup as on 156. ArdiaCore: `ACBrowserWindow` loses `MaybeShowProfileSwitchIPH()` and
  `MaybeShowSupervisedUserProfileSignInIPH()`, gone from `BrowserWindow`. `//chrome/browser/ardia`:
  `CredentialUIEntry::password` is a `PasswordString` now, so `ac_passwords.cc` copies the value out, clears the
  field (which `chromium-password-string-erase` zeroes) and zeroes its copy; `ac_cli_token_policy_web_targets.cc`
  asks `HasWebUIBindings` and `ProcessMap::Contains` with a `ChildProcessId`.
- **Build.** The first build compiled for 2 h 24 min (official, ThinLTO, PGO; the Metal Toolchain was already
  installed) and stopped on those five files; the rebuild with them fixed linked the framework in 11 min.
  `helium-check-build.py` passes, with the same 9 resources still naming Helium as 156's framework.
- **Checked in a hidden instance.** chrome://version and `/json/version` say 157.0.8103.38; a new tab loads a page and
  switching tabs shows one page and hides the other; our uBlock Origin blocks an ad request and replaces Google's ad
  script with its stand-in; Settings › Privacy has no Helium services row and its services route shows no page; no
  first-run, onboarding or ToS page opens; Save Page reaches Chrome's save panel through `chrome::ExecuteCommand`
  (the browser command path `disable-actions-for-browser-commands` keeps); a whole session's net log names no Helium
  host; Quit exits cleanly.

### 0.20.1 → 0.20.3 (Chromium 156.0.8078.79, 2026-10-31)

Two Chromium patch releases (156.0.8078.73 and .79, Chrome's stable updates of 2026-10-28 and 2026-10-29). What changed
in Helium, and what we did:

- **Series.** Both series are unchanged: the same 369 patches in the same order (355 applied, 14 skipped); `flags.gn`, `deps.ini` and the resources are unchanged. Helium
  refreshed context for each Chromium release, and reworked its native !bangs loading (a shared cache per URL, a retry
  with backoff, nothing fetched while the pref is off). helium-macos only refreshed context.
- **Skips and guards.** Every `SKIP` entry is still in the series and still a leaf, the `guard` stage finds the same
  four reviewed hits, `domsub-keep-store.txt` keeps the same 16 store files, and both resource lists copy 56 files.
- **Our series.** Every patch and both layers applied, but two needed work. `chromium-helium-bangs-off`: `LoadBangs` is
  rewritten for the new loader and answers with an empty catalogue before any fetch or retry. `chromium-extension-omaha-attributes`
  applied and then failed to compile: ungoogled's `fix-building-without-safebrowsing` now also deletes
  `UpdateService::OnCrxStateChange`'s `should_perform_action_on_omaha_attributes`, so the patch declares it and sets it
  for up-to-date and update-found results again, as Chromium does.
- **Toolchain.** Xcode 27.2 ships without the Metal Toolchain, which ANGLE's Metal shaders need: the first build failed
  with "cannot execute tool 'metal'" until `xcodebuild -downloadComponent MetalToolchain` installed it (840 MB, once per
  Xcode).

### 0.19.4 → 0.20.1 (Chromium 156.0.8078.47, 2026-10-25)

What changed in Helium, and what we did:

- **Series.** Added: `upstream-fixes/wasm-interpreter-fixes` (V8's Wasm interpreter on 156) and ungoogled's
  `add-flag-to-hide-window-buttons` (a chrome://flags switch, off by default, for Chrome's own browser windows).
  Removed: `upstream-fixes/tab-restore-live-tabs` (in Chromium 156 now) and `helium/core/enable-bookmark-bar-settings`.
  The rest is Helium's context refresh for 156 and its tab layout and zen mode work, which only Chrome's own
  `BrowserView` shows. helium-macos only refreshed context. `flags.gn`, `flags.macos.gn`, `deps.ini` and the resources
  are unchanged, and no patch adds a host, a service or a network call.
- **Skips and guards.** Every `SKIP` entry is still in the series and still a leaf; the `guard` stage finds the same
  four reviewed hits, so `GUARD_ALLOWED` is unchanged. `domsub-keep-store.txt` keeps the same 16 store files, and
  `ardia_resources.txt` and Helium's resource list copy the same 56 files.
- **Proxy flags.** ungoogled's `add-flags-for-existing-switches` already had Proxy server and Proxy bypass list
  flags in 0.19.4 (0.20.1 only moved their context). On a real profile ArdiaCore drops `--proxy-server`
  after chrome://flags apply, so they never did anything; the branding patch now takes both flags out.
- **Step 3.** The `patches` stage counted Chromium's own empty `third_party/search_engines_data/resources_internal`
  (a gitlink every checkout has) as an omitted download; only a file or a directory with something in it counts now
  (4309c156).
- **Our series.** Context refreshed in `chromium-helium-branding` (the crash product), `chromium-helium-services-page-off`
  (`router.ts`) and `chromium-devtools-control-token`, whose token mode now refuses an Origin before 156's new
  same-origin acceptance. Rewritten for 156: `chromium-autofill-address-bubble-window` (156 `CHECK`s the save-card
  bubble's handler; we return instead), `chromium-window-hosted` (`UnloadController` is a state machine; the hook
  asks `is_attempting_to_close_browser()`), `chromium-thaw-live-connections` (156 gates periodic unfreezing on
  `IsPeriodicUnfreezingActive()`) and `chromium-video-super-resolution` (`SwapFrameData` carries a `gfx::FrameData`,
  so the flag goes straight into it; `direct_renderer.h` and `skia_renderer.cc` are no longer touched).
- **Hooks.** Chromium 156 polls the Mac Bluetooth adapter on the UI thread again (no `OnBackgroundPollComplete`), so
  `engine/ardiacore/apply.sh`'s on-demand polling hook wraps the synchronous `PollAdapter`. Because that poll now
  runs inside `LazyInitialize`, before `StartScanWithFilter` starts discovery, it sees no discovery and stops; so a
  scan that starts asks for the next poll itself (`PollAdapterOnDemand` after `AdapterDiscoveringChanged`), and the
  500 ms loop runs again for as long as discovery does.
- **ArdiaCore.** `ACBrowserWindow` answers 156's new `BrowserWindow::GetPinnedToolbarActions()` with null (no toolbar),
  and `WindowHost`'s close calls `UnloadController`'s renamed `RunBeforeUnloadForShutdown()` and
  `ResetBeforeUnloadForShutdown()` (155's `TryToCloseWindow()` and `ResetTryToCloseWindow()`); `ACBrowserWindow::Close()`
  then reaches `HandleBeforeClose()`'s confirmed-shutdown branch, as Chrome's `BrowserCloseManager` does.

### Licence and source

Helium's patches are GPL-3.0, so the engine framework built from them, and Ardia as distributed, is GPL-3.0. Our own
files stay Apache-2.0. Our patches that change Helium's code say so in their `SPDX-License-Identifier: GPL-3.0-only`
header; the ones carried from ungoogled-chromium keep `BSD-3-Clause`.

Every release links its Corresponding Source: the repo at its tag, plus `ArdiaCore-<tree>-source.tar.xz`, which
`scripts/release.sh` packs with `scripts/engine-source.sh` for each new engine. It holds Helium's two tags, the
onboarding and uBlock Origin versions Helium's `deps.ini` pins, and where Chromium's tag and source tarball are.
chrome://credits keeps Helium's entry (`third_party/helium`). Helium's name appears nowhere else in the UI.

## Tab capture

A page that calls
`getUserMedia({video: {mandatory: {chromeMediaSource: "desktop", chromeMediaSourceId: id}}})`
captures the tab behind `id`; Chromium's `DesktopMediaID::Parse` already understands the id. Asking
for `audio: {mandatory: {chromeMediaSource: "desktop"}}` gets that tab's audio instead of system
audio. Capturing reads Chromium's own compositor frames, so macOS asks for no Screen Recording
permission.

In the app:

- The WebView method `mediaCaptureSourceId()` returns the id.
- The share picker answers a `displayMediaRequest` with that id and whether to share audio, and the page
  script asks for desktop audio when the answer says so.
- What audio the picker offers follows Chrome's picker: tab audio (checked by default), system audio for a
  screen, and for a window system audio, or the app's own audio when the page asks `windowAudio: "window"`
  (both unchecked by default). `systemAudio: "exclude"` and `windowAudio: "exclude"` hide the checkbox. System
  audio needs Core Audio taps (macOS 14.2+, `DesktopMediaPickerController::IsSystemAudioCaptureSupported`), app
  audio also `kApplicationAudioCaptureMac` (`media::IsApplicationLoopbackCaptureSupported`); the engine reports
  both (`ArdiaCoreEngine.desktopCaptureAudio`). macOS asks for System Audio Recording the first time
  (`NSAudioCaptureUsageDescription`).
- The answer lets one getUserMedia request of the asking frame, within 15 s, capture exactly the picked
  source (`ac_desktop_capture.mm`), with the audio it was granted: `audio_share` for a tab or screen, and a
  window's `window_audio_type` (`chromium-desktop-capture-window-audio.patch` lets Chrome's handler pass that
  on). Anything else is refused: the page script runs in the page's world, so the page decides what
  getUserMedia asks for, and audio it wasn't granted never reaches it.
- Desktop getUserMedia without a picked source is refused outright, with no prompt (as in Chrome, where
  only `getDisplayMedia` and its picker capture the screen). Only camera and microphone get a permission
  prompt.

Verified in the app: a "Tab" track at 1558×1080 delivering frames, plus a "Tab Audio" track.

## CEF's 117 patches

What became of each patch in CEF 154's `patch/patches` (branch 8037) when CEF left the tree. "Dropped" means
ArdiaCore doesn't need it: it serves a platform we don't ship, off-screen rendering (OSR), CEF's Alloy runtime, CEF's
own API, Views or build, or crash upload.

| Patch | Now |
|---|---|
| `angle_commit_config` | dropped (CEF source tarballs) |
| `base_command_line_1872` | dropped (CEF API: lower-case switch names) |
| `base_logging_3951` | dropped (Windows bootstrap) |
| `base_rand_util_lazy_seed` | dropped (Windows DCHECK builds) |
| `base_test_4396276` | dropped (CEF's test binaries) |
| `base_thread_pool_5548577` | dropped (CEF's multi-threaded message loop; Windows/Linux only) |
| `blink_ax_viewport_collapse` | dropped (CEF API: accessibility tree collapse) |
| `blink_web_element_4200240` | dropped (CEF API) |
| `blink_window_size_3714` | dropped (CEF's Document PiP options) |
| `browser_scheduler` | dropped (multi-threaded message loop shutdown) |
| `browser_security_policy_1081397` | dropped (CEF's custom schemes) |
| `chrome_autofill_bubble_3796` | folded (`chromium-autofill-address-bubble-window`) |
| `chrome_browser` | dropped (CEF build) |
| `chrome_browser_browser` | hook (H1, H2); folded (`chromium-cef-carryover`: `DeleteBrowser` order, the tab strip API's colour provider without an active tab; its `browser_ui_controller` guard against a tab that loads before it's in the strip, kept as `chromium-ui-update-before-insert` until 2026-10-15, dropped with it); rest dropped |
| `chrome_browser_content_settings` | dropped (a `NOTREACHED` only CEF's tests hit) |
| `chrome_browser_context_menus` | dropped (H4 is `ACContextMenu::Show()`) |
| `chrome_browser_devtools_osr` | dropped (OSR) |
| `chrome_browser_dialogs_jsmodal` | dropped (Alloy, OSR) |
| `chrome_browser_dialogs_misc` | dropped (OSR; CEF's toolbar-less extension dialog anchor) |
| `chrome_browser_dialogs_native` | dropped (CEF API: file dialog interception) |
| `chrome_browser_dialogs_widget` | dropped (OSR dialog parents, CEF Views) |
| `chrome_browser_download` | dropped (CEF API: download delegate) |
| `chrome_browser_extensions` | dropped (Alloy tabs API, CEF's PDF viewer delegate) |
| `chrome_browser_extensions_background` | folded (`chromium-cef-carryover`: `gn gen` asserts without it, given `enable_background_mode=false`) |
| `chrome_browser_frame_mac` | dropped (CEF Views) |
| `chrome_browser_metrics_tpm_476896967` | dropped (a Windows TPM driver crash) |
| `chrome_browser_permission_prompt` | hook (H3) |
| `chrome_browser_policy` | dropped (CEF API: policy configuration) |
| `chrome_browser_printing_oop_osr` | dropped (OSR) |
| `chrome_browser_privacy_1119417` | dropped (CEF build; Windows/Linux) |
| `chrome_browser_profile_menu` | dropped (Chrome's profile menu, which ArdiaCore never shows) |
| `chrome_browser_profiles` | dropped (CEF's incognito request contexts) |
| `chrome_browser_safe_browsing` | dropped (component build) |
| `chrome_browser_startup` | dropped (CEF API: process singleton) |
| `chrome_browser_task_manager` | dropped (multi-threaded message loop shutdown) |
| `chrome_browser_views_dangling_rawptr` | dropped (Chrome's toolbar, which ArdiaCore never shows) |
| `chrome_browser_webui_license` | dropped (CEF's chrome://license) |
| `chrome_browser_webui_version` | dropped (CEF's chrome://version) |
| `chrome_common_logging` | dropped (CEF build: logging on in Release) |
| `chrome_plugins` | dropped (CEF API) |
| `chrome_renderer` | dropped (CEF build) |
| `chrome_renderer_print_preview` | dropped (CEF API: per-frame print preview) |
| `chrome_runtime` | hook (H5, H6); its `ConfigureNetworkContextParams` `bool` return and `CleanupOnUIThread` dropped |
| `chrome_runtime_views` | dropped (CEF Views) |
| `color_provider_manager_3610` | dropped (CEF Views) |
| `component_build` | dropped (component build) |
| `component_updater_4087` | dropped (CEF API: component updater) |
| `components_gcm_disable` | dropped (ungoogled's `disable-gcm` now applies in full) |
| `config_3892` | dropped (CEF API: preferences and variations) |
| `content_2015` | dropped (ArdiaCore's `ConfigureNetworkContextParams` is `void` again) |
| `content_main_654986` | dropped (CEF's split `ContentMain`; ArdiaCore starts through `ChromeMain`) |
| `content_throttle_registry` | dropped (CEF API) |
| `crashpad_1995` | dropped (CEF's crash reporting; crashpad stays off) |
| `crashpad_tp_1995` | dropped (crash upload) |
| `dawn_dxil_redist` | dropped (Windows) |
| `devtools_ai_assistance_skills` | dropped (CEF build: DevTools' AI assistance bundle) |
| `embedder_product_override` | dropped (CEF API: User-Agent product) |
| `gn_config` | dropped (CEF build) |
| `gritsettings` | dropped (CEF build) |
| `libxml_visibility` | dropped (CEF build) |
| `light_mode_3534` | dropped (CEF's force-light/dark mode switches) |
| `linux_assets_path_1936` | dropped (Linux) |
| `linux_atk_1123214` | dropped (Linux) |
| `linux_chrome_widevine_3149` | dropped (Linux) |
| `linux_glib_deprecated_volatile` | dropped (Linux) |
| `linux_gtk_theme_3610` | dropped (Linux) |
| `linux_gwp_asan_3803` | dropped (Linux) |
| `linux_printing_context` | dropped (Linux) |
| `mac_chrome_locale_3623` | folded (`chromium-cef-carryover`: only `LoadLocalState`'s ResourceBundle delegate, for H5); its Mac UI locale from Local State dropped (Chrome's own on the Mac: Cocoa's, the first of the app's `CFBundleLocalizations`, Chromium's desktop locales, that the Mac's preferred languages match; extensions get it through `chrome.i18n`) |
| `mac_event_observer_2539` | dropped (CEF's own `NSApplication`; ArdiaCore runs Chrome's) |
| `mac_fling_scheduler_2540` | dropped (OSR) |
| `mac_keyboard_conversion_1467329` | folded (`chromium-cef-carryover`) |
| `mac_platform_style_bubble_893292` | folded (`chromium-cef-carryover`: `kAdjustBubbleIfOffscreen`); its `profile_menu_view_base.cc` hunk dropped (Chrome's profile menu, which ArdiaCore never shows) |
| `mac_print_preview_modal` | folded (`chromium-cef-carryover`: child-modal resize and focus); its Save as PDF file dialog policy dropped (`PdfPrinterHandler::SelectFile` already checks it) |
| `mac_render_widget_3680` | dropped (CEF Views: `acceptsFirstMouse`) |
| `message_loop` | dropped (Windows; multi-threaded message loop) |
| `metrics_system_profile` | dropped (multi-threaded message loop) |
| `mime_handler_view_guest_1565_2727` | dropped (OSR) |
| `mojo_connect_result_3664` | dropped (CEF API) |
| `net_cookie_flags` | dropped (CEF API: per-request cookies) |
| `net_test_server_3798752` | dropped (tests) |
| `net_url_request_3596` | dropped (CEF's custom schemes) |
| `osr_fling_2745` | dropped (OSR) |
| `osr_win_remove_keyed_mutex_2575` | dropped (Windows OSR) |
| `printing_context_2196` | dropped (Linux) |
| `raw_ptr_3239` | dropped (CEF's directory listing) |
| `renderer_host_1070713` | dropped (CEF API: background colour) |
| `renderer_host_aura` | dropped (Aura: Windows/Linux) |
| `resource_bundle_2512` | dropped (CEF's threading) |
| `rfh_navigation_4829483` | dropped (CEF's custom schemes and window callback) |
| `runhooks` | dropped (Windows toolchain) |
| `screen_1443650` | dropped (`Screen::*RectInWindow` has only Aura and Windows callers) |
| `services_network_2622` | dropped (CEF API: cookieable schemes) |
| `services_network_2718` | dropped (the `bool` `ConfigureNetworkContextParams`) |
| `set_resize_background_color` | dropped (CEF Views) |
| `tarball_deps` | dropped (CEF source tarballs) |
| `tarball_gclient` | dropped (CEF source tarballs) |
| `trace_event` | dropped (CEF's trace categories) |
| `ui_base_x11_util` | dropped (Linux) |
| `ui_dragdrop_355390` | dropped (Linux) |
| `ui_menu_model_3577` | dropped (CEF menus) |
| `ui_views_widget_type` | dropped (CEF Views; Linux) |
| `v8_build` | dropped (CEF build) |
| `views_1749_2102_3330` | dropped (CEF Views and menus) |
| `views_textfield_5399416` | dropped (CEF Views) |
| `views_widget` | dropped (CEF Views: external parents; mostly Windows/Linux) |
| `viz_capture_3826` | dropped (OSR) |
| `viz_osr_2575` | dropped (OSR) |
| `web_contents_1257_1565` | dropped (OSR, CEF API) |
| `webkit_move_pip` | dropped (CEF's Document PiP options) |
| `webkit_plugin_info_2015` | dropped (CEF API) |
| `win_app_icon_3606` | dropped (Windows) |
| `win_ax_platform_node` | dropped (Windows) |
| `win_sandbox_3210` | dropped (Windows) |
| `win_shell_dialogs_3294` | dropped (Windows) |
| `win_taskbar_decorator_3645` | dropped (Windows) |
| `win_taskbar_group_3641` | dropped (Windows) |
