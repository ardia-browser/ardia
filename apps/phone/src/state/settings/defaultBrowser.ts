import { create } from "zustand";
import { defaultBrowser, type DefaultBrowserStatus } from "../../platform/defaultBrowser";
import type { DefaultBrowserAction } from "./settingsRules";
import { settled } from "../pages/store";

export const useDefaultBrowser = create<{ status: DefaultBrowserStatus | null }>()(() => ({ status: null }));

export const defaultBrowserStatus = () => useDefaultBrowser.getState().status;

export async function refreshDefaultBrowser(): Promise<DefaultBrowserStatus | null> {
  const status = await settled(() => defaultBrowser.status(), null);
  useDefaultBrowser.setState({ status });
  return status;
}

export type DefaultBrowserAnswer = { status: DefaultBrowserStatus | null; unavailable: boolean };

export async function askForDefaultBrowser(does: DefaultBrowserAction | null): Promise<DefaultBrowserAnswer> {
  let unavailable = false;
  try {
    if (does === "askForRole") await defaultBrowser.requestRole();
    else if (does === "openDefaultApps") await defaultBrowser.openDefaultAppsSettings();
  } catch {
    unavailable = true;
  }
  return { status: await refreshDefaultBrowser(), unavailable };
}
