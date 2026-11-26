import { pluginRegistryOverrides } from "../../platform/launchConfig";

export const DEFAULT_REGISTRY = "https://ardia.dev/r";

const BUILT_IN_REGISTRY_KEYS: Readonly<Record<string, string>> = {};

const BUILT_IN_NATIVE_KEYS: Readonly<Record<string, string>> = {};

const KEYED = /^([A-Za-z0-9._:-]{1,128})=([\s\S]+)$/;

export function parseKeyList(text: string | null | undefined): Record<string, string> {
  if (!text) return {};
  const out: Record<string, string> = {};
  text
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .forEach((part, i) => {
      const keyed = KEYED.exec(part);
      if (keyed && keyed[2]!.trim().length >= 40) out[keyed[1]!] = keyed[2]!.trim();
      else out[i ? `test-${i}` : "test"] = part;
    });
  return out;
}

const LOOPBACK = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?(?:\/|$)/;

export function registryUrl(given: string, allowLoopback = false): string | null {
  const trimmed = given.trim().replace(/\/+$/, "").replace(/\/index\.json$/, "");
  if (!/^https:\/\/[a-z0-9.-]+(?::\d{1,5})?(?:\/[^\s?#]*)?$/i.test(trimmed) && !(allowLoopback && LOOPBACK.test(trimmed))) return null;
  if (/[\s\\]/.test(trimmed) || trimmed.includes("@")) return null;
  return trimmed;
}

export function defaultRegistryUrl(): string {
  const asked = pluginRegistryOverrides().url;
  return (asked && registryUrl(asked, true)) || DEFAULT_REGISTRY;
}

export function defaultRegistryKeys(): Record<string, string> {
  const given = parseKeyList(pluginRegistryOverrides().registryKeys);
  return Object.keys(given).length ? given : { ...BUILT_IN_REGISTRY_KEYS };
}

export function officialNativeKeys(): Record<string, string> {
  const given = parseKeyList(pluginRegistryOverrides().nativeKeys);
  return Object.keys(given).length ? given : { ...BUILT_IN_NATIVE_KEYS };
}
