import { asSecret, type Secret } from "@ardia/core";
import { keychainDelete, keychainRead, keychainReadSecret, keychainSet, keychainSetSecret } from "../../platform/keychain";

const SECRET_LIMITS = { keys: 64, valueBytes: 16 * 1024 } as const;
const SECRET_KEY = /^[A-Za-z0-9_-]{1,64}$/;

export type SecretOutcome<T> = { ok: true; value: T } | { ok: false; code: "bad_request" | "failed"; message: string };

const secretAccount = (plugin: string, key: string) => `ardia.plugin.${plugin}.${key}`;
const indexAccount = (plugin: string) => `ardia.plugin-index.${plugin}`;

const queues = new Map<string, Promise<unknown>>();

function queued<T>(plugin: string, work: () => Promise<T>): Promise<T> {
  const run = (queues.get(plugin) ?? Promise.resolve()).then(work, work);
  queues.set(plugin, run.catch(() => {}));
  return run;
}

const fail = <T,>(code: "bad_request" | "failed", message: string): SecretOutcome<T> => ({ ok: false, code, message });
const isSecretKey = (key: unknown): key is string => typeof key === "string" && SECRET_KEY.test(key);

type Index = { ok: true; keys: string[] } | { ok: false; message: string };

const UNREADABLE_INDEX = "The Keychain's list of this plugin's secrets can't be read, so Ardia leaves it alone.";

type Read = { ok: true; value: string | null } | { ok: false; message: string };

async function readKeychain(account: string): Promise<Read> {
  try {
    const read = await keychainRead(account);
    if (read.status === "ok") return { ok: true, value: read.value };
    if (read.status === "missing") return { ok: true, value: null };
    return { ok: false, message: `The Keychain couldn't be read: ${read.reason}` };
  } catch (error) {
    return { ok: false, message: `The Keychain didn't answer: ${String(error)}` };
  }
}

async function indexOf(plugin: string): Promise<Index> {
  const read = await readKeychain(indexAccount(plugin));
  if (!read.ok) return read;
  if (read.value === null) return { ok: true, keys: [] };
  try {
    const parsed: unknown = JSON.parse(read.value);
    return Array.isArray(parsed) && parsed.every(isSecretKey) ? { ok: true, keys: parsed } : { ok: false, message: UNREADABLE_INDEX };
  } catch {
    return { ok: false, message: UNREADABLE_INDEX };
  }
}

async function deleteFromKeychain(account: string): Promise<string | null> {
  try {
    return (await keychainDelete(account)) === false ? "The Keychain didn't delete it." : null;
  } catch (error) {
    return `The Keychain didn't delete it: ${String(error)}`;
  }
}

async function writeIndex(plugin: string, keys: string[]): Promise<boolean> {
  if (!keys.length) return (await keychainDelete(indexAccount(plugin)).catch(() => false)) !== false;
  return (await keychainSet(indexAccount(plugin), JSON.stringify(keys)).catch(() => false)) !== false;
}

export function getPluginSecret(plugin: string, key: unknown): Promise<SecretOutcome<Secret<"pluginSecret"> | null>> {
  if (!isSecretKey(key)) return Promise.resolve(fail("bad_request", "key is 1 to 64 letters, digits, - and _."));
  return queued(plugin, async () => {
    try {
      const read = await keychainReadSecret(secretAccount(plugin, key), "pluginSecret");
      if (read.status === "ok") return { ok: true as const, value: read.value };
      if (read.status === "missing") return { ok: true as const, value: null };
      return fail<Secret<"pluginSecret"> | null>("failed", `The Keychain couldn't be read: ${read.reason}`);
    } catch (error) {
      return fail<Secret<"pluginSecret"> | null>("failed", `The Keychain didn't answer: ${String(error)}`);
    }
  });
}

export function setPluginSecret(plugin: string, key: unknown, value: unknown): Promise<SecretOutcome<true>> {
  if (!isSecretKey(key)) return Promise.resolve(fail("bad_request", "key is 1 to 64 letters, digits, - and _."));
  if (typeof value !== "string" || new TextEncoder().encode(value).length > SECRET_LIMITS.valueBytes) return Promise.resolve(fail("bad_request", `value is text of at most ${SECRET_LIMITS.valueBytes / 1024} KB.`));
  const secret = asSecret("pluginSecret", value);
  return queued(plugin, async () => {
    const index = await indexOf(plugin);
    if (!index.ok) return fail<true>("failed", index.message);
    const keys = index.keys;
    if (!keys.includes(key)) {
      if (keys.length >= SECRET_LIMITS.keys) return fail<true>("bad_request", `A plugin keeps at most ${SECRET_LIMITS.keys} secrets.`);
      if (!(await writeIndex(plugin, [...keys, key]))) return fail<true>("failed", "The Keychain didn't save it.");
    }
    const saved = await keychainSetSecret(secretAccount(plugin, key), secret).catch(() => false);
    return saved === false ? fail<true>("failed", "The Keychain didn't save it.") : { ok: true as const, value: true as const };
  });
}

export function deletePluginSecret(plugin: string, key: unknown): Promise<SecretOutcome<true>> {
  if (!isSecretKey(key)) return Promise.resolve(fail("bad_request", "key is 1 to 64 letters, digits, - and _."));
  return queued(plugin, async () => {
    const index = await indexOf(plugin);
    if (!index.ok) return fail<true>("failed", index.message);
    const problem = await deleteFromKeychain(secretAccount(plugin, key));
    if (problem) return fail<true>("failed", problem);
    const keys = index.keys;
    if (keys.includes(key) && !(await writeIndex(plugin, keys.filter((k) => k !== key)))) return fail<true>("failed", "The secret is gone, but the Keychain didn't update the plugin's list of secrets.");
    return { ok: true as const, value: true as const };
  });
}

export type SecretsCleared = { ok: boolean; remaining: string[]; reason?: string };

export const pluginSecretKeys = (plugin: string): Promise<string[]> => queued(plugin, async () => {
  const index = await indexOf(plugin);
  return index.ok ? index.keys : [];
});

export function clearPluginSecrets(plugin: string): Promise<SecretsCleared> {
  return queued(plugin, async () => {
    const index = await indexOf(plugin);
    if (!index.ok) return { ok: false, remaining: [], reason: index.message };
    const remaining: string[] = [];
    for (const key of index.keys) if (await deleteFromKeychain(secretAccount(plugin, key))) remaining.push(key);
    const indexed = await writeIndex(plugin, remaining);
    return { ok: indexed && remaining.length === 0, remaining };
  });
}
