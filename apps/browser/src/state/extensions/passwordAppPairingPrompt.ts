import { onExtensionInstallPrompt, onExtensionsChanged } from "../../platform/extensions";
import { showToast } from "../app/toasts";
import { openFile } from "../app/system";
import { useBrowser } from "../browser/store";
import { focusedWindowOf } from "../windows/ui";
import { notePasswordAppPairing } from "../telemetry/usage";
import { consentToken, type ConsentToken } from "../telemetry/client";
import { passwordAppPairing } from "./passwordAppPairing";
import { pairingToastActions } from "./pairingToast";
import { extensionProfile, useExtensions } from "./store";

export const ONE_PASSWORD_EXTENSION_IDS: ReadonlySet<string> = new Set([
  "aeblfdkhhhdcdjpifhhbdiojplfjncoa",
  "khgocmkkpikpnmmkgmdnfckapcdkgfaf",
  "gejiddohjgogedgjnonbofjigllpkmbf",
  "hjlinigoblmkhjejkmbegnoaljkphmgo",
  "dppgmdbiimibapkepcbdbmkaabgiofem",
]);

export const pairsWithPasswordApp = (extensionId: string) => ONE_PASSWORD_EXTENSION_IDS.has(extensionId);

export function openPasswordApp(appPath: string) {
  notePasswordAppPairing("opened");
  void openFile(appPath);
}

const PENDING_MS = 10 * 60_000;
const asked = new Map<string, { consent: ConsentToken | null; at: number; windowId: string | null }>();
let watching = false;

const installKey = (profile: string, id: string) => `${profile}\n${id}`;

function windowShowing(profile: string, preferred: string | null): string | null {
  const s = useBrowser.getState();
  const shows = (w: string | null | undefined): w is string => !!w && !!s.windows[w] && extensionProfile(s, w) === profile;
  return [preferred, focusedWindowOf(s), ...s.ui.focusOrder, ...s.windowOrder].find(shows) ?? null;
}

function showPairing(key: string) {
  const pending = asked.get(key);
  asked.delete(key);
  if (!pending || Date.now() - pending.at > PENDING_MS) return;
  const pairing = passwordAppPairing();
  const windowId = windowShowing(key.split("\n")[0]!, pending.windowId);
  if (!pairing || !windowId) return;
  notePasswordAppPairing("shown", pending.consent);
  showToast(windowId, pairing.title, pairing.steps, {
    icon: "key.fill",
    key: "passwordAppPairing",
    sticky: true,
    titleLines: 1,
    ...pairingToastActions(pairing.appPath, openPasswordApp),
  });
}

function showInstalled(lists: Record<string, readonly { id: string }[] | undefined>) {
  for (const [key, pending] of [...asked]) {
    if (Date.now() - pending.at > PENDING_MS) {
      asked.delete(key);
      continue;
    }
    const [profile, id] = key.split("\n");
    if (lists[profile!]?.some((x) => x.id === id)) showPairing(key);
  }
}

export function watchPasswordAppPairing() {
  if (watching) return;
  watching = true;
  onExtensionInstallPrompt((prompt) => {
    if (prompt.type !== "install" || !pairsWithPasswordApp(prompt.id)) return;
    if (useExtensions.getState().lists[prompt.profile]?.some((x) => x.id === prompt.id)) return;
    asked.set(installKey(prompt.profile, prompt.id), { consent: consentToken(), at: Date.now(), windowId: (prompt.tabId && useBrowser.getState().tabs[prompt.tabId]?.windowId) || null });
  });
  onExtensionsChanged((e) => {
    if (e.event === "installed") showPairing(installKey(e.profile, e.id));
  });
  useExtensions.subscribe((s, prev) => {
    if (asked.size && s.lists !== prev.lists) showInstalled(s.lists);
  });
}
