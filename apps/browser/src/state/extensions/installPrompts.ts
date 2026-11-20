import { resolveExtensionInstallPrompt, type ExtensionInstallPrompt } from "../../platform/extensions";

export const declinePrompt = (prompt: ExtensionInstallPrompt) => void resolveExtensionInstallPrompt(prompt, false).catch(() => {});

let heldPrompt: { windowId: string; prompt: ExtensionInstallPrompt } | null = null;

export function holdPrompt(windowId: string, prompt: ExtensionInstallPrompt) {
  if (heldPrompt) declinePrompt(heldPrompt.prompt);
  heldPrompt = { windowId, prompt };
}

export function takeHeldPrompt() {
  const held = heldPrompt;
  heldPrompt = null;
  return held;
}
