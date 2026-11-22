import { ZH_HANS } from "./zhHans";

export type UiLanguage = "en" | "zh-Hans";

const HANT_REGIONS = new Set(["TW", "HK", "MO"]);

export function uiLanguageFromTag(tag: string): UiLanguage {
  const parts = tag.trim().replace(/_/g, "-").split("-").filter(Boolean);
  const language = parts[0]?.toLowerCase() ?? "";
  if (language !== "zh") return "en";
  const script = parts.find((part) => /^[A-Za-z]{4}$/.test(part))?.toLowerCase();
  const region = parts.find((part) => /^([A-Za-z]{2}|\d{3})$/.test(part))?.toUpperCase();
  if (script === "hant" || (region !== undefined && HANT_REGIONS.has(region))) return "en";
  if (script === "hans" || region === undefined || region === "CN" || region === "SG") return "zh-Hans";
  return "en";
}

let current: UiLanguage = uiLanguageFromTag(Intl.DateTimeFormat().resolvedOptions().locale);

export function adoptUiLanguage(tag: string): void {
  current = uiLanguageFromTag(tag || "en");
}

export function uiLanguage(): UiLanguage {
  return current;
}

export function translate(text: string, language: UiLanguage = current): string {
  if (language !== "zh-Hans" || text === "") return text;
  const leading = text.match(/^\s*/)?.[0] ?? "";
  const trailing = text.match(/\s*$/)?.[0] ?? "";
  const key = text.slice(leading.length, text.length - trailing.length);
  const hit = ZH_HANS[key];
  if (hit === undefined) return text;
  return `${leading}${hit}${trailing}`;
}

export function t(text: string): string {
  return translate(text);
}
