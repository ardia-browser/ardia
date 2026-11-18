import type { Design } from "./design";

export type InterfaceStyleChoice = "matchMac" | "glass" | "classic";
export type SchemeChoice = "matchMac" | "system" | "light" | "dark";
export type ChromeStyle = "glass" | "classic";
export type PreferredScheme = "light" | "dark" | null;
export type MacLook = { interfaceStyle: "glass" | "classic" | null; appearance: "auto" | "light" | "dark" | null };

export const INTERFACE_STYLES: readonly InterfaceStyleChoice[] = ["matchMac", "glass", "classic"];
export const SCHEME_CHOICES: readonly SchemeChoice[] = ["matchMac", "system", "light", "dark"];

export const INTERFACE_STYLE_NAMES: Record<InterfaceStyleChoice, string> = { matchMac: "Match My Mac", glass: "Glass", classic: "Classic" };
export const SCHEME_NAMES: Record<SchemeChoice, string> = { matchMac: "Match My Mac", system: "System", light: "Light", dark: "Dark" };

export const macLookOf = (syncEnabled: boolean, look: MacLook | null | undefined): MacLook | null => (syncEnabled ? (look ?? null) : null);

export function resolvedInterfaceStyle(choice: InterfaceStyleChoice, mac: MacLook | null): ChromeStyle {
  if (choice !== "matchMac") return choice;
  return mac?.interfaceStyle === "classic" ? "classic" : "glass";
}

export function chromeStyle(design: Design, choice: InterfaceStyleChoice, mac: MacLook | null, reduceTransparency: boolean): ChromeStyle {
  if (design !== "redesigned") return "glass";
  return !reduceTransparency && resolvedInterfaceStyle(choice, mac) === "glass" ? "glass" : "classic";
}

export function preferredScheme(design: Design, choice: SchemeChoice, mac: MacLook | null): PreferredScheme {
  if (design !== "redesigned" || choice === "system") return null;
  if (choice === "light" || choice === "dark") return choice;
  return mac?.appearance === "light" || mac?.appearance === "dark" ? mac.appearance : null;
}

export const appliedDark = (preferred: PreferredScheme, systemDark: boolean) => (preferred === null ? systemDark : preferred === "dark");

export const offeredInterfaceStyle = (choice: InterfaceStyleChoice, offersSync: boolean): InterfaceStyleChoice => (offersSync || choice !== "matchMac" ? choice : "glass");

export const offeredScheme = (choice: SchemeChoice, offersSync: boolean): SchemeChoice => (offersSync || choice !== "matchMac" ? choice : "system");

export function appearanceSummary(colorName: string | null, shownStyle: InterfaceStyleChoice, shownScheme: SchemeChoice, offersSync = true): string {
  const style = offeredInterfaceStyle(shownStyle, offersSync);
  const scheme = offeredScheme(shownScheme, offersSync);
  const parts = [colorName, style === "matchMac" ? null : INTERFACE_STYLE_NAMES[style], scheme === "matchMac" ? null : SCHEME_NAMES[scheme]].filter((part): part is string => part !== null);
  return parts.length ? parts.join(", ") : "Match My Mac";
}

const TELEMETRY_STYLE = { matchMac: "match_mac", glass: "glass", classic: "classic" } as const;
const TELEMETRY_SCHEME = { matchMac: "match_mac", system: "system", light: "light", dark: "dark" } as const;

export const appearanceTelemetry = (style: InterfaceStyleChoice, scheme: SchemeChoice) => ({ interface_style: TELEMETRY_STYLE[style], color_scheme: TELEMETRY_SCHEME[scheme] });

export const TABS_STYLE_FOOTER = "How your open tabs are laid out. Swipe up on the bottom bar to see them.";
