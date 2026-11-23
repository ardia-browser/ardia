import type { ClearSiteDataResult, SiteSettingType, SiteSettingValue, SiteSettings } from "../../siteSettings";
import type { PageEngine, StorageItems } from "../../webkit";
import type { Profile } from "../wire";

export type SitesCalls = {
  "sites.settings": [Profile & { origin: string; engine: PageEngine }, SiteSettings];
  "sites.setSetting": [Profile & { origin: string; type: SiteSettingType; value: SiteSettingValue; engine: PageEngine }, null];
  "sites.origins": [Profile, string[]];
  "sites.reset": [Profile & { origin: string }, null];
  "sites.clearData": [Profile & { origin: string; engine: PageEngine }, ClearSiteDataResult];
  "sites.zoomLevels": [Profile, Record<string, number>];
  "sites.readStorage": [Profile & { origin: string }, { items: StorageItems | null }];
  "sites.writeStorage": [Profile & { origin: string; set: StorageItems; remove: string[] }, { written: number }];
  "sites.registrableDomains": [Profile & { hosts: string[] }, { domains: string[] }];
  "sites.setZoom": [Profile & { host: string; zoom: number }, null];
  "sites.preloadPages": [Profile, boolean];
  "sites.setPreloadPages": [Profile & { on: boolean }, null];
};

export type SitesEvents = {};
