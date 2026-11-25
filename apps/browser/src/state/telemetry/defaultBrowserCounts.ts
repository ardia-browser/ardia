import { isDefaultBrowser } from "../../platform/app";
import { consentToken, counted } from "./choice";

let promptsOpened = 0;
let launchesAsDefault = 0;
let checkedAtLaunch = false;

export const noteDefaultBrowserPrompt = () => void promptsOpened++;

export function checkDefaultBrowserAtLaunch(read: () => Promise<boolean> = isDefaultBrowser) {
  if (checkedAtLaunch) return;
  checkedAtLaunch = true;
  const consent = consentToken();
  void read().then(
    (isDefault) => void (isDefault && counted(consent, () => launchesAsDefault++)),
    () => {},
  );
}

export function takeDefaultBrowserCounts() {
  const taken = { default_browser_prompts_opened: promptsOpened, launches_as_default_browser: launchesAsDefault };
  promptsOpened = 0;
  launchesAsDefault = 0;
  return taken;
}
