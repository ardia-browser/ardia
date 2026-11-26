import { notePlugin } from "../telemetry/pluginCounts";
import { consentToken } from "../telemetry/choice";
import { ownValue } from "../../lib/decode";
import { currentPlugins, enabledInProfile } from "./store";
import { deletePluginSecret, pluginSecretKeys, secretSpace, setPluginSecret, type SecretOutcome } from "./secrets";

const fail = (message: string): SecretOutcome<true> => ({ ok: false, code: "bad_request", message });

const isSecretRow = (plugin: string, key: string) => !!currentPlugins().listings[plugin]?.manifest?.settings.rows.some((r) => r.key === key && r.type === "secret");

export function secretRowSpace(plugin: string, profileId: string | null): string | null {
  const manifest = currentPlugins().listings[plugin]?.manifest;
  if (manifest?.scope !== "profile") return plugin;
  if (!profileId) return null;
  const profiles = ownValue(currentPlugins().records, plugin)?.profiles;
  return enabledInProfile({ profiles }, profileId) ? secretSpace(plugin, profileId) : null;
}

export function setPluginSecretRow(plugin: string, key: string, value: string | null, profileId: string | null = null): Promise<SecretOutcome<true>> {
  if (!isSecretRow(plugin, key)) return Promise.resolve(fail(`${plugin} has no secret row ${key}.`));
  const space = secretRowSpace(plugin, profileId);
  if (!space) return Promise.resolve(fail(`${plugin} isn't on in that profile.`));
  if (value === null || value === "") return deletePluginSecret(space, key);
  const consent = consentToken();
  return setPluginSecret(space, key, value).then((outcome) => {
    if (outcome.ok) notePlugin("plugin_secret_writes", consent);
    return outcome;
  });
}

export async function pluginSecretRowIsSet(plugin: string, key: string, profileId: string | null = null): Promise<boolean> {
  const space = secretRowSpace(plugin, profileId);
  if (!isSecretRow(plugin, key) || !space) return false;
  return (await pluginSecretKeys(space)).includes(key);
}
