import { appUrlRoute } from "@ardia/core";
import { SETTINGS_PANES, type SettingsPane } from "../settings/settingsWindows";

const PANE_ALIASES: Record<string, SettingsPane> = {
  people: "profiles",
  manageprofile: "profiles",
  managespace: "spaces",
  syncsetup: "general",
  sync: "general",
  privacy: "general",
  addresses: "profiles",
  payments: "profiles",
  autofill: "profiles",
  passwords: "profiles",
  extensions: "profiles",
  search: "profiles",
  searchengines: "profiles",
  airtraffic: "automations",
  livefolders: "automations",
  calendar: "automations",
  engines: "advanced",
};

export type AppUrlAction = { kind: "newTab" } | { kind: "settings"; pane: SettingsPane | undefined };

export function appUrlAction(url: string): AppUrlAction | null {
  const route = appUrlRoute(url);
  if (route?.kind === "newTab") return { kind: "newTab" };
  if (route?.kind !== "settings") return null;
  if (route.section === null) return { kind: "settings", pane: undefined };
  const section = route.section.toLowerCase();
  const pane = PANE_ALIASES[section] ?? SETTINGS_PANES.find((p) => p.toLowerCase() === section);
  return pane ? { kind: "settings", pane } : null;
}
