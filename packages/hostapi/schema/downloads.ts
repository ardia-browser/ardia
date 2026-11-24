import { defineDomain } from "../define.ts";

export const downloads = defineDomain({
  kind: "engine",
  imports: {
    "../wire": ["Profile"],
    "../../downloads": ["Download", "DownloadSettings"],
  },
  calls: {
    settings: {
      args: "Profile",
      result: "DownloadSettings",
      service: "ac_downloads_settings",
      desktop: "route",
    },
    setSettings: {
      args: 'Profile & Partial<Pick<DownloadSettings, "folder" | "askWhereToSave">>',
      result: "DownloadSettings",
      service: "ac_downloads_set_settings",
      desktop: "route",
    },
    cancel: {
      args: "{ id: string }",
      result: "null",
      service: "ac_downloads_command",
      desktop: "route",
      routeField: "null",
      mac: "custom",
      windows: "custom",
    },
    pause: {
      args: "{ id: string }",
      result: "null",
      service: "ac_downloads_command",
      desktop: "route",
      routeField: "null",
      mac: "custom",
      windows: "custom",
    },
    resume: {
      args: "{ id: string }",
      result: "null",
      service: "ac_downloads_command",
      desktop: "route",
      routeField: "null",
      mac: "custom",
      windows: "custom",
    },
    keep: {
      args: "{ id: string }",
      result: "null",
      service: "ac_downloads_command",
      desktop: "route",
      routeField: "null",
      mac: "custom",
      windows: "custom",
    },
  },
  events: {
    changed: {
      payload: "Download",
      desktop: "forward",
      mac: "custom",
      windows: "custom",
    },
  },
});
