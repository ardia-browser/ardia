import { setVaultPasskeys } from "../../platform/vaults";
import { useBrowser } from "../browser/store";
import { useExtensions, type InstalledExtension } from "../extensions/store";
import type { VaultProviderState } from "../../platform/vaults";
import { useVaults } from "./store";

export type PasskeyVendor = "proton" | "onepassword" | "bitwarden" | "dashlane" | "nordpass" | "keeper" | "lastpass" | "other";

export const KNOWN_PASSKEY_EXTENSIONS: Readonly<Record<string, PasskeyVendor>> = {
  ghmbeldphafepmbegfdlkpapadhbakde: "proton",
  aeblfdkhhhdcdjpifhhbdiojplfjncoa: "onepassword",
  khgocmkkpikpnmmkgmdnfckapcdkgfaf: "onepassword",
  nngceckbapebfimnlniiiahkandclblb: "bitwarden",
  fdjamakpfbbddfjaooikfcpapjohcfmg: "dashlane",
  eiaeiblijfjekdanodkjadfinkhbfgcd: "nordpass",
  bfogiafebfohielmmehodmfbbebbbpei: "keeper",
  hdokiejnpimakedhajhdlcegeplioahd: "lastpass",
};

export const ASK_SOURCE = "ask";
export const ARDIA_SOURCE = "ardia";
export const CHROME_SOURCE = "chrome";
export const extensionSource = (id: string) => `ext:${id}`;
export const extensionOfSource = (source: string) => (source.startsWith("ext:") ? source.slice(4) : null);
export const providerSource = (id: string) => `provider:${id}`;
export const providerOfSource = (source: string) => (source.startsWith("provider:") ? source.slice("provider:".length) : null);

export type SystemSource = { id: string; name: string };

export const passkeyVendorOf = (id: string): PasskeyVendor => KNOWN_PASSKEY_EXTENSIONS[id] ?? "other";

export type PasskeyExtension = { id: string; name: string; icon: string };

export const shortExtensionName = (name: string) => name.split(/\s*[:|\u2013\u2014]\s+|\s+-\s+/)[0]!.trim() || name;

const isExtensionId = (id: string) => /^[a-p]{32}$/.test(id);

export function enabledExtensions(lists: Readonly<Record<string, readonly InstalledExtension[]>>): PasskeyExtension[] {
  const seen = new Map<string, PasskeyExtension>();
  for (const list of Object.values(lists)) {
    for (const e of list) if (e.enabled && isExtensionId(e.id) && !seen.has(e.id)) seen.set(e.id, { id: e.id, name: shortExtensionName(e.name), icon: e.icon });
  }
  return [...seen.values()];
}

export function passkeyExtensions(lists: Readonly<Record<string, readonly InstalledExtension[]>>, observed: readonly string[]): PasskeyExtension[] {
  const noted = new Set(observed);
  return enabledExtensions(lists)
    .filter((e) => e.id in KNOWN_PASSKEY_EXTENSIONS || noted.has(e.id))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

export function effectiveSource(setting: string, available: readonly PasskeyExtension[], systems: readonly SystemSource[] = []): string {
  const extension = extensionOfSource(setting);
  if (extension) return available.some((e) => e.id === extension) ? setting : ASK_SOURCE;
  const provider = providerOfSource(setting);
  if (provider) return systems.some((m) => m.id === provider) ? setting : ASK_SOURCE;
  return setting === ARDIA_SOURCE || setting === CHROME_SOURCE ? setting : ASK_SOURCE;
}

export type SourceOption = { value: string; title: string };

export function sourceOptions(available: readonly PasskeyExtension[], systems: readonly SystemSource[] = []): SourceOption[] {
  return [
    { value: ASK_SOURCE, title: "Ask Each Time" },
    { value: ARDIA_SOURCE, title: "Ardia" },
    ...systems.map((m) => ({ value: providerSource(m.id), title: `${m.name} App` })),
    ...available.map((e) => ({ value: extensionSource(e.id), title: e.name })),
    { value: CHROME_SOURCE, title: "Chrome (Security Key or Phone)" },
  ];
}

export function usePasskeyExtensions(): PasskeyExtension[] {
  const lists = useExtensions((s) => s.lists);
  const observed = useBrowser((s) => s.settings.vaultPasskeyExtensions);
  return passkeyExtensions(lists, observed);
}

export function noteObservedExtensions(ids: readonly string[]) {
  const fresh = [...new Set(ids)].filter((id) => isExtensionId(id) && !(id in KNOWN_PASSKEY_EXTENSIONS));
  if (!fresh.length) return;
  const { settings, updateSettings } = useBrowser.getState();
  const known = new Set(settings.vaultPasskeyExtensions);
  const added = fresh.filter((id) => !known.has(id));
  if (added.length) updateSettings({ vaultPasskeyExtensions: [...settings.vaultPasskeyExtensions, ...added].slice(-64) });
}

export const declaredPasskeyExtensions = (providers: readonly VaultProviderState[]) =>
  new Set(providers.flatMap((p) => (p.capabilities.passkeysVia ?? []).flatMap((r) => (r.via === "extension" ? r.extensions : []))));

let sent = "";

function sendConfig() {
  const { settings } = useBrowser.getState();
  const lists = useExtensions.getState().lists;
  const declared = declaredPasskeyExtensions(useVaults.getState().providers);
  const extensions = enabledExtensions(lists).map(({ id, name }) => ({ id, name, known: id in KNOWN_PASSKEY_EXTENSIONS || declared.has(id) }));
  const setting = settings.vaultPasskeySource;
  const source = providerOfSource(setting) ? setting : effectiveSource(setting, passkeyExtensions(lists, settings.vaultPasskeyExtensions));
  const payload = { source, extensions };
  const key = JSON.stringify(payload);
  if (key === sent) return;
  sent = key;
  void setVaultPasskeys(payload).catch(() => {
    if (sent === key) sent = "";
  });
}

let started = false;

export function startPasskeySources() {
  if (started) return;
  started = true;
  sendConfig();
  useBrowser.subscribeTo(["settings"], (s, prev) => {
    if (s.settings !== prev.settings) sendConfig();
  });
  useExtensions.subscribe((s, prev) => {
    if (s.lists !== prev.lists) sendConfig();
  });
  useVaults.subscribe((s, prev) => {
    if (s.providers !== prev.providers) sendConfig();
  });
}
