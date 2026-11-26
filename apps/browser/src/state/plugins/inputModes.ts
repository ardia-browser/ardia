import { registerOmniboxProvider, type OmniboxProvider } from "../omnibox/providers";
import { useBrowser } from "../browser/store";
import { activeTabId } from "../browser/model";
import { notePlugin } from "../telemetry/pluginCounts";
import { consentToken, type ConsentToken } from "../telemetry/choice";
import { warnFor } from "../telemetry/consoleConsent";
import { runPluginCommand } from "./commands";
import { grantTabLease } from "./pageApis";
import { manifestInProfile, windowProfileId } from "./profileScope";
import { activeManifest, currentPlugins, usePlugins } from "./store";
import type { PluginManifest } from "../../lib/pluginManifest";

export const INPUT_PREFIX = "ardia-input:";
const MAX_QUERY = 2000;
const TAB_CHIP = /(?:^|\s)@tab\b/g;
const KEYWORD = /^[A-Za-z0-9_-]{1,32}$/;

export type InputModeSpec = { plugin: string; id: string; title: string; placeholder: string | null; icon: string | null; keyword: string; command: string };

export function inputModesOf(plugin: string, m: PluginManifest): InputModeSpec[] {
  const c = m.v3.contributes ?? {};
  return (c.inputModes ?? []).flatMap((mode) => {
    const command = (c.commands ?? []).find((x) => x.inputMode === mode.id);
    const keyword = [...(mode.keywords ?? []), mode.id].find((k) => KEYWORD.test(k));
    if (!command || !keyword || !m.commands.some((x) => x.name === command.name)) return [];
    return [{ plugin, id: mode.id, title: mode.title, placeholder: mode.placeholder ?? null, icon: mode.icon ?? null, keyword, command: command.name }];
  });
}

export const inputUrl = (plugin: string, mode: string, query: string) => `${INPUT_PREFIX}${plugin}/${mode}?q=${encodeURIComponent(query.slice(0, MAX_QUERY))}`;

export function parseInputUrl(url: string): { plugin: string; mode: string; query: string } | null {
  if (!url.startsWith(INPUT_PREFIX)) return null;
  const found = /^([a-z0-9][a-z0-9_-]{0,80})\/([a-z0-9][a-z0-9-]{0,63})\?q=(.*)$/.exec(url.slice(INPUT_PREFIX.length));
  if (!found) return null;
  try {
    return { plugin: found[1]!, mode: found[2]!, query: decodeURIComponent(found[3]!).slice(0, MAX_QUERY) };
  } catch {
    return null;
  }
}

function providerFor(spec: InputModeSpec, pluginTitle: string): OmniboxProvider {
  return {
    id: `plugin:${spec.plugin}:mode:${spec.id}`,
    title: spec.title,
    keyword: spec.keyword,
    async query(text, signal, context = {}) {
      if (signal.aborted || !text.trim() || !manifestInProfile(currentPlugins(), spec.plugin, windowProfileId(context.windowId))) return [];
      return [{ title: `${spec.title}: ${text.trim().slice(0, 120)}`, subtitle: spec.placeholder ?? pluginTitle, url: inputUrl(spec.plugin, spec.id, text), icon: spec.icon }];
    },
  };
}

export function runPluginInput(url: string, windowId: string, done: () => void): boolean {
  const parsed = parseInputUrl(url);
  if (!parsed) return false;
  const consent = consentToken();
  done();
  const m = manifestInProfile(currentPlugins(), parsed.plugin, windowProfileId(windowId));
  const spec = m ? inputModesOf(parsed.plugin, m).find((x) => x.id === parsed.mode) : undefined;
  if (!spec) return true;
  const asksForTab = /(?:^|\s)@tab\b/.test(parsed.query);
  const query = parsed.query.replace(TAB_CHIP, " ").replace(/\s+/g, " ").trim();
  const tabId = asksForTab ? activeTabId(useBrowser.getState(), windowId) : null;
  notePlugin("plugin_input_modes", consent);
  void (tabId ? grantTabLease(parsed.plugin, tabId, consent) : Promise.resolve(false)).then((leased) =>
    runPluginCommand(parsed.plugin, spec.command, windowId, { from: "inputMode", inputMode: spec.id, query, ...(leased && tabId ? { tabs: [tabId] } : {}) }, undefined, consent),
  );
  return true;
}

const registered = new Map<string, { revision: string; unregister: () => void }>();

function reconcile(consent: ConsentToken | null) {
  const s = currentPlugins();
  const wanted = new Map<string, { spec: InputModeSpec; title: string; revision: string }>();
  for (const plugin of s.order) {
    const m = activeManifest(s, plugin);
    if (!m?.main) continue;
    for (const spec of inputModesOf(plugin, m)) wanted.set(`${plugin}:${spec.id}`, { spec, title: m.title, revision: `${s.listings[plugin]?.hash}:${JSON.stringify(spec)}` });
  }
  for (const [id, entry] of registered) {
    if (wanted.get(id)?.revision === entry.revision) continue;
    entry.unregister();
    registered.delete(id);
  }
  for (const [id, want] of wanted) {
    if (registered.has(id)) continue;
    try {
      registered.set(id, { revision: want.revision, unregister: registerOmniboxProvider(providerFor(want.spec, want.title)) });
    } catch (error) {
      warnFor(consent, `[plugins] ${want.spec.plugin}'s input mode ${want.spec.id} couldn't register`, error);
    }
  }
}

let watching = false;

export function watchPluginInputModes() {
  if (watching) return;
  watching = true;
  reconcile(consentToken());
  usePlugins.subscribe((s, prev) => {
    if (s.listings !== prev.listings || s.records !== prev.records || s.order !== prev.order) reconcile(consentToken());
  });
}
