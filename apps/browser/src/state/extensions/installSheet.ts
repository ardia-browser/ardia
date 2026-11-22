import { chooseExtensionFolder, inspectUnpackedExtension, installExtension, resolveExtensionInstallPrompt, type ExtensionInstallPrompt, type ExtensionPackage } from "../../platform/extensions";
import { useBrowser } from "../browser/store";
import { errorText } from "../../lib/errors";
import { isUtilityWindowId } from "../settings/settingsWindows";
import { isWindowClosing } from "../windows/closingWindows";
import { isOpenRegularWindow, isSmallWindow } from "../windows/small";
import { noteUnpackedInstall } from "../telemetry/exportCounts";
import { consentToken, type ConsentToken } from "../telemetry/client";
import { noteExtensionInstallPromptStale } from "../telemetry/usage";
import { declinePrompt, holdPrompt, takeHeldPrompt } from "./installPrompts";
import { refreshExtensions, refreshExtensionsAfterChange } from "./lists";
import { extensionProfile, nextInstallKey, useExtensions, type InstallRequest } from "./store";

const STALE_PROMPT = "This install request has closed. Open the extension's page in the Chrome Web Store and add it again.";

const utilityHosts = new Map<string, number>();

const windowCanShow = (windowId: string) => (isUtilityWindowId(windowId) ? (utilityHosts.get(windowId) ?? 0) > 0 : !!useBrowser.getState().windows[windowId] && !isWindowClosing(windowId));

const sheetCanShow = (request: InstallRequest) => windowCanShow(request.windowId);

export function utilitySheetHost(windowId: string): () => void {
  utilityHosts.set(windowId, (utilityHosts.get(windowId) ?? 0) + 1);
  return () => {
    const left = (utilityHosts.get(windowId) ?? 1) - 1;
    if (left > 0) return void utilityHosts.set(windowId, left);
    utilityHosts.delete(windowId);
    const request = useExtensions.getState().install;
    if (request?.windowId === windowId && request.status !== "installing") cancelInstall(request.key);
  };
}

function shownWindowFor(windowId: string): string | null {
  if (windowCanShow(windowId) && useBrowser.getState().windows[windowId]?.kind !== "private") return windowId;
  const s = useBrowser.getState();
  return [...s.ui.focusOrder, ...s.windowOrder].find((id) => isOpenRegularWindow(s.windows[id]) || (isSmallWindow(s.windows[id]) && !isWindowClosing(id))) ?? null;
}

export function showInstallSheet(next: InstallRequest): boolean {
  const current = useExtensions.getState().install;
  if (current?.status === "installing") return false;
  if (current?.status === "prompt") declinePrompt(current.prompt);
  useExtensions.setState({ install: next });
  return true;
}

function showHeldPrompt() {
  if (useExtensions.getState().install) return;
  const held = takeHeldPrompt();
  if (!held) return;
  const windowId = shownWindowFor(held.windowId);
  if (!windowId) return declinePrompt(held.prompt);
  showInstallSheet({ key: nextInstallKey(), windowId, profile: held.prompt.profile, source: "webStore", status: "prompt", prompt: held.prompt });
}

export function showInstallPrompt(windowId: string, prompt: ExtensionInstallPrompt) {
  if (useExtensions.getState().install?.status === "installing") return holdPrompt(windowId, prompt);
  showInstallSheet({ key: nextInstallKey(), windowId, profile: prompt.profile, source: "webStore", status: "prompt", prompt });
}

export async function loadUnpacked(windowId: string, profile = extensionProfile(useBrowser.getState(), windowId)): Promise<boolean> {
  const path = await chooseExtensionFolder();
  if (!path) return false;
  try {
    const pkg = await inspectUnpackedExtension(path);
    return showInstallSheet({ key: nextInstallKey(), windowId, profile, source: "unpacked", status: "ready", pkg });
  } catch (error) {
    return showInstallSheet({ key: nextInstallKey(), windowId, profile, source: "unpacked", status: "error", error: errorText(error) });
  }
}

const ownRequest = (key?: number) => {
  const request = useExtensions.getState().install;
  return request && (key === undefined || request.key === key) ? request : null;
};

function failSheet(request: InstallRequest, error: string) {
  if (useExtensions.getState().install?.key !== request.key) return;
  const failed: InstallRequest = { key: request.key, windowId: request.windowId, profile: request.profile, source: request.source, status: "error", error };
  useExtensions.setState({ install: sheetCanShow(request) ? failed : null });
  showHeldPrompt();
}

async function acceptPrompt(request: Extract<InstallRequest, { status: "prompt" }>) {
  const consent = consentToken();
  useExtensions.setState({ install: null });
  try {
    await resolveExtensionInstallPrompt(request.prompt, true);
  } catch (error) {
    const stale = (error as { code?: unknown } | null)?.code === "ERR_EXTENSION_PROMPT_STALE";
    if (stale) noteExtensionInstallPromptStale(consent);
    if (useExtensions.getState().install) return;
    useExtensions.setState({ install: { key: request.key, windowId: request.windowId, profile: request.profile, source: request.source, status: "error", error: stale ? STALE_PROMPT : errorText(error) } });
    return;
  }
  for (const ms of [1500, 5000]) setTimeout(() => void refreshExtensions(request.profile, consent), ms);
}

async function addPackage(request: Extract<InstallRequest, { pkg: ExtensionPackage }>, consent: ConsentToken | null) {
  useExtensions.setState({ install: { ...request, status: "installing" } });
  try {
    await installExtension(request.pkg, request.profile);
  } catch (error) {
    return failSheet(request, errorText(error));
  }
  if (request.source === "unpacked") noteUnpackedInstall(consent);
  if (useExtensions.getState().install?.key === request.key) useExtensions.setState({ install: null });
  showHeldPrompt();
  await refreshExtensionsAfterChange(request.profile, consent);
}

export async function confirmInstall(key?: number) {
  const request = ownRequest(key);
  if (request?.status === "prompt") return acceptPrompt(request);
  if (request?.status !== "ready") return;
  await addPackage(request, consentToken());
}

export function cancelInstall(key?: number) {
  const request = ownRequest(key);
  if (!request || request.status === "installing") return;
  if (request.status === "prompt") declinePrompt(request.prompt);
  useExtensions.setState({ install: null });
  showHeldPrompt();
}
