import { notePlugin } from "../telemetry/pluginCounts";
import { consentToken } from "../telemetry/choice";
import { currentPlugins } from "./store";
import { deletePluginSecret, pluginSecretKeys, setPluginSecret, type SecretOutcome } from "./secrets";

const fail = (message: string): SecretOutcome<true> => ({ ok: false, code: "bad_request", message });

const isSecretRow = (plugin: string, key: string) => !!currentPlugins().listings[plugin]?.manifest?.settings.rows.some((r) => r.key === key && r.type === "secret");

export function setPluginSecretRow(plugin: string, key: string, value: string | null): Promise<SecretOutcome<true>> {
  if (!isSecretRow(plugin, key)) return Promise.resolve(fail(`${plugin} has no secret row ${key}.`));
  if (value === null || value === "") return deletePluginSecret(plugin, key);
  const consent = consentToken();
  return setPluginSecret(plugin, key, value).then((outcome) => {
    if (outcome.ok) notePlugin("plugin_secret_writes", consent);
    return outcome;
  });
}

export async function pluginSecretRowIsSet(plugin: string, key: string): Promise<boolean> {
  if (!isSecretRow(plugin, key)) return false;
  return (await pluginSecretKeys(plugin)).includes(key);
}
