import { onExtensionInstallPrompt, onExtensionsChanged } from "../../platform/extensions";
import { capture, consentToken, type ConsentToken } from "./client";

const EXTENSION_SETTLE_MS = 20_000;
const MAX_PROMPTED = 50;
const prompted = new Map<string, ConsentToken | null>();
let watching = false;

const installKey = (profile: string, id: string) => `${profile}\n${id}`;

export function watchExtensionInstalls(startedAt: number) {
  if (watching) return;
  watching = true;
  onExtensionInstallPrompt((prompt) => {
    const key = installKey(prompt.profile, prompt.id);
    prompted.delete(key);
    prompted.set(key, consentToken());
    if (prompted.size > MAX_PROMPTED) prompted.delete(prompted.keys().next().value!);
  });
  onExtensionsChanged((e) => {
    if (e.event !== "installed") return;
    const key = installKey(e.profile, e.id);
    const consent = prompted.get(key) ?? null;
    prompted.delete(key);
    if (Date.now() - startedAt > EXTENSION_SETTLE_MS) capture("extension_installed", {}, consent);
  });
}
