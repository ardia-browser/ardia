import { isFields } from "../../lib/decode";
import type { OmniboxSpec } from "../../lib/pluginManifest";
import { pluginWebUrl } from "../../lib/pluginWebUrl";
import { registerOmniboxProvider, type OmniboxProvider, type ProviderRow } from "../omnibox/providers";
import { notePlugin } from "../telemetry/pluginCounts";
import { consentToken, type ConsentToken } from "../telemetry/choice";
import { warnFor } from "../telemetry/consoleConsent";
import { activeManifest, currentPlugins, usePlugins } from "./store";
import { invokePluginCall } from "./tools";

const OMNIBOX_TIMEOUT_MS = 1500;
const OMNIBOX_LIMITS = { rows: 8, title: 120, subtitle: 200, badge: 20, query: 500 } as const;

const UNSAFE = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g;
const SYMBOL = /^[a-z0-9.]{1,64}$/;

const pluginProviderId = (plugin: string, id: string) => `plugin:${plugin}:${id}`;

const cleanText = (value: unknown, max: number) => (typeof value === "string" ? value.replace(UNSAFE, "").trim().slice(0, max) : "");

function sanitizedRows(result: unknown): ProviderRow[] {
  const raw = Array.isArray(result) ? result : isFields(result) && Array.isArray(result.suggestions) ? result.suggestions : [];
  const rows: ProviderRow[] = [];
  for (const value of raw) {
    if (rows.length >= OMNIBOX_LIMITS.rows) break;
    if (!isFields(value)) continue;
    const title = cleanText(value.title, OMNIBOX_LIMITS.title);
    const checked = pluginWebUrl(value.url);
    if (!title || "problem" in checked) continue;
    const row: ProviderRow = { title, url: checked.url };
    const subtitle = cleanText(value.subtitle, OMNIBOX_LIMITS.subtitle);
    const badge = cleanText(value.badge, OMNIBOX_LIMITS.badge);
    if (subtitle) row.subtitle = subtitle;
    if (typeof value.icon === "string" && SYMBOL.test(value.icon)) row.icon = value.icon;
    if (badge) row.badge = badge;
    rows.push(row);
  }
  return rows;
}

function providerFor(plugin: string, spec: OmniboxSpec): OmniboxProvider & { global: boolean; plugin: string } {
  return {
    id: pluginProviderId(plugin, spec.id),
    title: spec.title,
    ...(spec.keyword ? { keyword: spec.keyword } : {}),
    global: spec.global,
    plugin,
    async query(text, signal) {
      if (signal.aborted || !activeManifest(currentPlugins(), plugin)) return [];
      notePlugin("plugin_omnibox_queries");
      const outcome = await invokePluginCall(plugin, { kind: "omnibox", provider: spec.id, query: text.slice(0, OMNIBOX_LIMITS.query) }, { kind: "host" }, OMNIBOX_TIMEOUT_MS, { signal });
      if (signal.aborted || !outcome.ok) return [];
      return sanitizedRows(outcome.result);
    },
  };
}

const registered = new Map<string, { revision: string; unregister: () => void }>();

function reconcilePluginOmnibox(consent: ConsentToken | null) {
  const s = currentPlugins();
  const wanted = new Map<string, { plugin: string; spec: OmniboxSpec; revision: string }>();
  for (const plugin of s.order) {
    const m = activeManifest(s, plugin);
    if (!m?.main) continue;
    for (const spec of m.contributes.omnibox) wanted.set(pluginProviderId(plugin, spec.id), { plugin, spec, revision: `${s.listings[plugin]?.hash}:${JSON.stringify(spec)}` });
  }
  for (const [id, entry] of registered) {
    if (wanted.get(id)?.revision === entry.revision) continue;
    entry.unregister();
    registered.delete(id);
  }
  for (const [id, want] of wanted) {
    if (registered.has(id)) continue;
    try {
      registered.set(id, { revision: want.revision, unregister: registerOmniboxProvider(providerFor(want.plugin, want.spec)) });
    } catch (error) {
      warnFor(consent, `[plugins] ${want.plugin}'s omnibox provider ${want.spec.id} couldn't register`, error);
    }
  }
}

let watching = false;

export function watchPluginOmnibox() {
  if (watching) return;
  watching = true;
  reconcilePluginOmnibox(consentToken());
  usePlugins.subscribe((s, prev) => {
    if (s.listings !== prev.listings || s.records !== prev.records || s.order !== prev.order) reconcilePluginOmnibox(consentToken());
  });
}
