import type { ActionPopupRequest, ActionState, ExtensionActionChange, ExtensionInstallPrompt, ExtensionPackage, ExtensionSyncIntent, ExtensionsChange, ExtensionsLoadHealth, ExtensionsSyncApplied, ExtensionsSyncApply, ExtensionsSyncState, InstalledExtension, SidePanelRequest, TabsRequest } from "../../extensions";
import type { Done, Profile } from "../wire";

export type ExtensionsCalls = {
  "extensions.list": [Profile, { extensions: InstalledExtension[] }];
  "extensions.inspectUnpacked": [{ path: string }, ExtensionPackage];
  "extensions.install": [Profile & { path: string }, { id: string }];
  "extensions.installCrx": [Profile & { path: string }, { id: string }];
  "extensions.setEnabled": [Profile & { id: string; enabled: boolean }, { ok: true }];
  "extensions.uninstall": [Profile & { id: string }, { ok: true }];
  "extensions.reload": [Profile & { id: string }, { ok: true }];
  "extensions.configure": [Profile & { id: string; options: Record<string, unknown> }, { ok: true }];
  "extensions.chooseFolder": [{}, string | null];
  "extensions.resolveInstallPrompt": [Profile & { requestId: string; accepted: boolean }, null];
  "extensions.actionStates": [Profile & { tabId: string; ids: string[] }, Record<string, ActionState>];
  "extensions.sidePanelUrl": [Profile & { tabId: string; extensionId: string }, string | null];
  "extensions.watchActions": [Profile, Done];
  "extensions.syncState": [Profile, ExtensionsSyncState];
  "extensions.syncApply": [Profile & ExtensionsSyncApply, ExtensionsSyncApplied];
  "extensions.loadHealth": [Profile, ExtensionsLoadHealth];
};

export type ExtensionsEvents = {
  "extensions.changed": ExtensionsChange;
  "extensions.tabs": TabsRequest;
  "extensions.installPrompt": ExtensionInstallPrompt;
  "extensions.installFailed": { message: string; tabId: string | null };
  "extensions.sidePanel": SidePanelRequest;
  "extensions.actionPopup": ActionPopupRequest;
  "extensions.actionShortcut": ActionPopupRequest;
  "extensions.action": ExtensionActionChange;
  "extensions.sync": { profile: string } & ExtensionSyncIntent;
};
