import { diffSecuritySurface } from "@ardia/plugin-sdk/registry";
import { configDirectory } from "../../platform/launchConfig";
import { isPluginId, keyOfId, splitPluginId } from "../../lib/pluginIds";
import { consentNow } from "../telemetry/choice";
import { notePlugin } from "../telemetry/pluginCounts";
import { openSettings } from "../settings/settingsWindows";
import { approvePlugin, requestPluginConsent, rescanPlugins } from "./lifecycle";
import { restartProcess } from "./process";
import { currentPlugins, recordOf } from "./store";

export type DevReloadReply = { ok: true; id: string; version: string | null } | { ok: false; error: { code: "bad_request" | "not_linked" | "manifest" | "needs_consent" | "control_off"; message: string } };

const refuse = (code: Extract<DevReloadReply, { ok: false }>["error"]["code"], message: string): DevReloadReply => ({ ok: false, error: { code, message } });

export function devLinkPath(id: string, config = configDirectory()): string | null {
  const parts = splitPluginId(id);
  return parts ? `${config.replace(/\/+$/, "")}/plugins-dev/${parts.scope}__${parts.name}.json` : null;
}

export const canonicalPath = (path: string) => path.replace(/\/+$/, "") || "/";

export async function devReload(params: Record<string, unknown>): Promise<DevReloadReply> {
  const { id, path, link } = params;
  if (!isPluginId(id) || typeof path !== "string" || !path.startsWith("/") || typeof link !== "string") return refuse("bad_request", "plugins.devReload needs an id like @you/name, the plugin's absolute path and its dev link");
  if (link !== devLinkPath(id)) return refuse("bad_request", `The dev link must be ${devLinkPath(id)}`);
  const key = keyOfId(id)!;
  const consent = consentNow();
  const before = currentPlugins().listings[key];
  await rescanPlugins(consent);
  const listing = currentPlugins().listings[key];
  if (!listing || listing.source !== "dev") return refuse("not_linked", `Ardia doesn't see a dev link for ${id}; run ardia-plugin dev again`);
  if (!listing.devPath || canonicalPath(path) !== canonicalPath(listing.devPath)) return refuse("bad_request", `${id}'s dev link points at ${listing.devPath ?? "another folder"}, not ${path}; run ardia-plugin dev from that folder`);
  if (!listing.manifest || !listing.hash) return refuse("manifest", listing.problems[0] ?? "plugin.json can't load");
  notePlugin("dev_reloads", consent);
  const record = recordOf(currentPlugins(), key);
  const known = before?.source === "dev" && before.manifest && record.enabled && record.approved === before.hash ? before.manifest.v3 : null;
  if (record.approved !== listing.hash) {
    const widened = !known || diffSecuritySurface(known, listing.manifest.v3).expanded;
    if (widened) {
      notePlugin("dev_reload_consents", consent);
      if (requestPluginConsent(key)) openSettings("plugins", null, key);
      return refuse("needs_consent", `${id} asks for something it didn't before; approve it in Ardia's Settings › Plugins`);
    }
    if (!approvePlugin(key, listing.hash, consent)) return refuse("manifest", "Ardia couldn't save its plugin settings");
  }
  restartProcess(key);
  return { ok: true, id, version: listing.manifest.version };
}
