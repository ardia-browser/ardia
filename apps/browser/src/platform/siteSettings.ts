import {
  call,
  WEBKIT_SITE_SETTINGS,
  type ClearSiteDataResult,
  type ExternalAppRequest,
  type PageEngine,
  type SiteSettings,
  type SiteSettingType,
  type SiteSettingValue,
} from "@ardia/ardiacore";

export { WEBKIT_SITE_SETTINGS };
export type { ExternalAppRequest, SiteSettingType, SiteSettingValue, SiteSettings, ClearSiteDataResult };

const settingChangeListeners = new Set<() => void>();
const announceSettingChange = () => settingChangeListeners.forEach((listener) => listener());
export function onSiteSettingChange(listener: () => void): () => void {
  settingChangeListeners.add(listener);
  return () => void settingChangeListeners.delete(listener);
}
function changingSettings<T>(change: () => Promise<T>): Promise<T> {
  announceSettingChange();
  return change().finally(announceSettingChange);
}

export const setSiteSetting = (profile: string, origin: string, type: SiteSettingType, value: SiteSettingValue, engine: PageEngine = "chromium") =>
  changingSettings(() => call("sites.setSetting", { profile, origin, type, value, engine }));
export const getSiteSettings = (profile: string, origin: string, engine: PageEngine = "chromium") => call("sites.settings", { profile, origin, engine });
export const getSiteSettingsOrigins = (profile: string) => call("sites.origins", { profile });
export const resetSiteSettings = (profile: string, origin: string) => changingSettings(() => call("sites.reset", { profile, origin }));
export const clearSiteData = (profile: string, origin: string, engine: PageEngine = "chromium") =>
  call("sites.clearData", { profile, origin, engine });

export const setZoom = (profile: string, host: string, zoom: number) => call("sites.setZoom", { profile, host, zoom });
export const getZoomLevels = (profile: string) => call("sites.zoomLevels", { profile });
export const getPreloadPages = (profile: string) => call("sites.preloadPages", { profile });
export const setPreloadPages = (profile: string, on: boolean) => call("sites.setPreloadPages", { profile, on });
export const setCommandScrollZoom = (enabled: boolean) => call("webView.setCommandScrollZoom", { enabled });

export const resolveExternalApp = (id: string, open: boolean, remember = false) => call("permissions.resolveExternalApp", { id, open, remember });
export const getExternalAppAllowances = (profile: string) => call("permissions.externalAppAllowances", { profile });
export const removeExternalAppAllowance = (profile: string, origin: string, scheme: string) =>
  call("permissions.removeExternalAppAllowance", { profile, origin, scheme }).then(() => {});
export const registrableDomainsOf = (profile: string, hosts: string[]) => call("sites.registrableDomains", { profile, hosts });
export const readChromiumStorage = (profile: string, origin: string) => call("sites.readStorage", { profile, origin });
export const writeChromiumStorage = (profile: string, origin: string, set: [string, string][], remove: string[]) =>
  call("sites.writeStorage", { profile, origin, set, remove });
