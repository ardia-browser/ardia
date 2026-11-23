import { forgetCredentialProvider, onCredentialRunWanted, setCredentialProvider } from "../../platform/plugins";
import { useBrowser } from "../browser/store";
import { updateSettings } from "../settings/actions";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { consentToken, type ConsentToken } from "../telemetry/choice";
import { warnFor } from "../telemetry/consoleConsent";
import { ensurePluginActivated, onPluginReady, pluginReadyRun } from "./activation";
import { onProcessStopped } from "./process";
import { activeManifest, currentPlugins, usePlugins, type PluginsStore } from "./store";

type Turned = { hash: string; run: number };

const turnedOn = new Map<string, Turned>();
const installed = new Set<string>();
const wantedAfterStop = new Set<string>();

const isInstalledProvider = (s: Pick<PluginsStore, "listings">, name: string) => {
  const listing = Object.hasOwn(s.listings, name) ? s.listings[name] : undefined;
  return !!listing?.official && !!listing.manifest?.contributes.credentialProvider;
};

function removed(name: string) {
  if (useBrowser.getState().settings.vaultSaveTarget === name) updateSettings({ vaultSaveTarget: "" });
}

export function dropRemovedSaveTargets(s: Pick<PluginsStore, "listings" | "records"> = currentPlugins()) {
  for (const name of Object.keys(s.listings)) if (isInstalledProvider(s, name)) installed.add(name);
  for (const name of [...installed]) {
    if (Object.hasOwn(s.listings, name) || Object.hasOwn(s.records, name)) continue;
    installed.delete(name);
    removed(name);
  }
}

const providerHash = (s: Pick<PluginsStore, "listings" | "records">, name: string): string | null => {
  const listing = Object.hasOwn(s.listings, name) ? s.listings[name] : undefined;
  return listing?.official && listing.hash && activeManifest(s, name)?.contributes.credentialProvider ? listing.hash : null;
};

function report(name: string, enabled: boolean, consent: ConsentToken | null) {
  const what = `[plugins] Ardia couldn't turn ${name}'s password manager ${enabled ? "on" : "off"}`;
  void setCredentialProvider(name, enabled).then(
    (answer) => answer.ok || warnFor(consent, `${what}: ${answer.reason ?? "no reason given"}`),
    (error: unknown) => warnFor(consent, what, error),
  );
}

const turnedOff = (s: Pick<PluginsStore, "listings" | "records">, name: string) =>
  Object.hasOwn(s.listings, name) && !(Object.hasOwn(s.records, name) && s.records[name]!.enabled);

function forgetTurnedOff(name: string, consent: ConsentToken | null) {
  const what = `[plugins] Ardia couldn't wipe ${name}'s password manager after it was turned off`;
  void forgetCredentialProvider(name).then(
    (answer) => {
      if (!answer.ok) return warnFor(consent, `${what}: ${answer.reason ?? "no reason given"}`);
      removed(name);
    },
    (error: unknown) => warnFor(consent, what, error),
  );
}

function ready(name: string, run: number, consent: ConsentToken | null) {
  const hash = providerHash(currentPlugins(), name);
  if (!hash) return;
  const before = turnedOn.get(name);
  if (before?.hash === hash && before.run === run) return;
  turnedOn.set(name, { hash, run });
  report(name, true, consent);
}

export function syncCredentialProviders(consent: ConsentToken | null, s: Pick<PluginsStore, "listings" | "records"> = currentPlugins()) {
  for (const [name, turned] of [...turnedOn]) {
    if (providerHash(s, name) === turned.hash) continue;
    turnedOn.delete(name);
    if (turnedOff(s, name)) forgetTurnedOff(name, consent);
    else report(name, false, consent);
  }
}

function wanted(name: string, consent: ConsentToken | null) {
  if (!providerHash(currentPlugins(), name)) return;
  if (pluginReadyRun(name) !== null) return void wantedAfterStop.add(name);
  void ensurePluginActivated(name, "credentials").catch((error: unknown) => warnFor(consent, `[plugins] ${name} didn't start for its password manager`, error));
}

export const credentialProvidersOn = () => [...turnedOn.keys()];

let watching = false;

export function watchCredentialProviders() {
  if (watching || !PLATFORM_FEATURES.plugins) return;
  watching = true;
  onPluginReady((name, run) => {
    wantedAfterStop.delete(name);
    ready(name, run, consentToken());
  });
  onProcessStopped((name) => {
    if (!wantedAfterStop.delete(name)) return;
    const consent = consentToken();
    void Promise.resolve().then(() => wanted(name, consent));
  });
  usePlugins.subscribe((s, prev) => {
    if (s.listings === prev.listings && s.records === prev.records) return;
    const consent = consentToken();
    syncCredentialProviders(consent, s);
    dropRemovedSaveTargets(s);
  });
  try {
    onCredentialRunWanted(({ name }) => wanted(name, consentToken()));
  } catch (error) {
    warnFor(consentToken(), "[plugins] Ardia can't hear when a password manager needs its plugin", error);
  }
}
