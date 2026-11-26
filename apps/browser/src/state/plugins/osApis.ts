import { isFields } from "../../lib/decode";
import { hasLevel, type PluginManifest } from "../../lib/pluginManifest";
import { matchesAllowedHost } from "../../lib/pluginNetwork";
import { splitPluginId } from "../../lib/pluginIds";
import { allowedHostsOf } from "../../lib/pluginPermissions";
import { urlParts } from "../../lib/urlParts";
import { copyText, readText } from "../../platform/clipboard";
import { onNotificationResponse, postNotification } from "../../platform/notifications";
import { pluginSignIn } from "../../platform/plugins";
import { acceptsRun } from "./process";
import { failure } from "../automation/automationMethods";
import type { Body } from "../automation/controlSocket";
import { notePlugin } from "../telemetry/pluginCounts";
import { consentToken } from "../telemetry/choice";
import { recentPluginGesture } from "./gestures";
import { hostFetch } from "./hostIo";
import { activeManifest, currentPlugins } from "./store";

type Caller = { name: string; run: number };

export const OS_LIMITS = { clipboardChars: 1_000_000, notifyGapMs: 2000, notifyPerHour: 30, scopes: 32 } as const;
const COMMAND = /^[a-z0-9][a-z0-9-]{0,63}$/;
const notified = new Map<string, number[]>();

const text = (value: unknown, max: number) => (typeof value === "string" && value.trim() ? value.slice(0, max) : undefined);

export const needsGesture = (c: Caller, what: string): Body | null =>
  recentPluginGesture(c.name) ? null : failure("refused", `${what} works only just after you use the plugin (a command, menu, toolbar button or its view).`);

export async function clipboardMethod(c: Caller, m: PluginManifest, method: string, params: Record<string, unknown>): Promise<Body> {
  const consent = consentToken();
  const reads = method === "clipboard.readText";
  if (!hasLevel(m.permissions, "clipboard", reads ? "read" : "write")) return failure("refused", `${method} needs clipboard: ${reads ? "read" : "write"}.`);
  const gesture = needsGesture(c, method);
  if (gesture) return gesture;
  if (reads) {
    notePlugin("plugin_clipboard_reads", consent);
    const value = await readText().catch(() => "");
    return { result: { text: typeof value === "string" ? value.slice(0, OS_LIMITS.clipboardChars) : "" } };
  }
  if (typeof params.text !== "string" || params.text.length > OS_LIMITS.clipboardChars) return failure("bad_request", "text is up to a million characters.");
  notePlugin("plugin_clipboard_writes", consent);
  copyText(params.text);
  return { result: { ok: true } };
}

export async function notifyMethod(c: Caller, m: PluginManifest, params: Record<string, unknown>, now = Date.now()): Promise<Body> {
  if (!m.permissions.notifications) return failure("refused", "ui.notify needs the notifications permission.");
  const title = text(params.title, 120);
  if (!title) return failure("bad_request", "ui.notify needs a title.");
  const command = params.command;
  if (command !== undefined && (typeof command !== "string" || !COMMAND.test(command) || !m.commands.some((x) => x.name === command))) return failure("bad_request", "command must be one of this plugin's commands.");
  const recent = (notified.get(c.name) ?? []).filter((t) => now - t < 3_600_000);
  if (recent.length >= OS_LIMITS.notifyPerHour || (recent.length && now - recent[recent.length - 1]! < OS_LIMITS.notifyGapMs)) return failure("refused", "The plugin is showing notifications too often.");
  notified.set(c.name, [...recent, now]);
  notePlugin("plugin_notifications", consentToken());
  const body = text(params.body, 400);
  const subtitle = text(params.subtitle, 120);
  const posted = await postNotification({
    title: `${m.title}: ${title}`,
    ...(body ? { body } : {}),
    ...(subtitle ? { subtitle } : {}),
    silent: params.silent === true,
    data: { ardiaPlugin: c.name, ...(typeof command === "string" ? { command } : {}) },
  }).catch(() => null);
  return posted ? { result: { ok: true } } : failure("failed", "The notification couldn't be shown.");
}

let watchingNotifications = false;

export function watchPluginNotifications(run: (plugin: string, command: string) => void) {
  if (watchingNotifications) return;
  watchingNotifications = true;
  onNotificationResponse((response) => {
    const data = isFields(response.data) ? response.data : null;
    if (response.action !== "click" || typeof data?.ardiaPlugin !== "string" || typeof data.command !== "string") return;
    if (!activeManifest(currentPlugins(), data.ardiaPlugin)?.commands.some((x) => x.name === data.command)) return;
    run(data.ardiaPlugin, data.command);
  });
}

export function signInUrl(m: PluginManifest, raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 4096) return null;
  const parts = urlParts(raw);
  if (parts?.scheme !== "https" || !parts.host) return null;
  return matchesAllowedHost(parts.host, allowedHostsOf(m.permissions)) ? raw : null;
}

function tokensOf(body: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(body);
    return isFields(parsed) ? parsed : null;
  } catch {
    return Object.fromEntries(new URLSearchParams(body));
  }
}

export async function signIn(c: Caller, m: PluginManifest, params: Record<string, unknown>): Promise<Body> {
  const consent = consentToken();
  const ids = splitPluginId(m.id);
  if (!ids) return failure("refused", "This plugin's id can't sign in.");
  const authorizeUrl = signInUrl(m, params.authorizeUrl);
  const tokenUrl = signInUrl(m, params.tokenUrl);
  if (!authorizeUrl || !tokenUrl) return failure("refused", "authorizeUrl and tokenUrl must be https addresses on hosts in this plugin's permissions.network.");
  const clientId = text(params.clientId, 512);
  if (!clientId) return failure("bad_request", "signIn needs a clientId.");
  const scopes = Array.isArray(params.scopes) ? params.scopes.filter((s): s is string => typeof s === "string").slice(0, OS_LIMITS.scopes) : [];
  const extraParams = isFields(params.extraParams) ? Object.fromEntries(Object.entries(params.extraParams).filter((e): e is [string, string] => typeof e[1] === "string")) : {};
  const gesture = needsGesture(c, "auth.signIn");
  if (gesture) return gesture;
  notePlugin("plugin_auth_signins", consent);
  const granted = await pluginSignIn({ plugin: c.name, run: c.run, scope: ids.scope.replace(/^@/, ""), pluginName: ids.name, authorizeUrl, clientId, scopes, extraParams }).catch((error: unknown) => ({ ok: false as const, reason: String(error) }));
  if (!granted.ok) {
    notePlugin("plugin_auth_failures", consent);
    return failure("cancelled" in granted && granted.cancelled ? "refused" : "failed", granted.reason);
  }
  const now = activeManifest(currentPlugins(), c.name);
  if (!acceptsRun(c.name, c.run) || !now || now.id !== m.id || signInUrl(now, tokenUrl) !== tokenUrl || now.permissions.network === false) {
    notePlugin("plugin_auth_failures", consent);
    return failure("refused", "The plugin stopped or changed while you were signing in, so Ardia dropped the sign-in.");
  }
  const form = new URLSearchParams({ grant_type: "authorization_code", code: granted.code, redirect_uri: granted.redirectUri, client_id: clientId, code_verifier: granted.verifier });
  const answered = await hostFetch({ url: tokenUrl, method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: form.toString(), timeoutMs: 30_000, allowedHosts: allowedHostsOf(now.permissions) });
  const tokens = answered.ok ? tokensOf(answered.body) : null;
  if (!answered.ok || answered.status < 200 || answered.status >= 300 || typeof tokens?.access_token !== "string") {
    notePlugin("plugin_auth_failures", consent);
    return failure("failed", answered.ok ? `The token exchange failed (${answered.status}).` : answered.reason);
  }
  const expiresIn = Number(tokens.expires_in);
  return {
    result: {
      accessToken: tokens.access_token,
      tokenType: typeof tokens.token_type === "string" ? tokens.token_type : "Bearer",
      ...(typeof tokens.refresh_token === "string" ? { refreshToken: tokens.refresh_token } : {}),
      ...(Number.isFinite(expiresIn) && expiresIn > 0 ? { expiresAt: Date.now() + expiresIn * 1000 } : {}),
      ...(typeof tokens.scope === "string" ? { scope: tokens.scope } : {}),
      ...(typeof tokens.id_token === "string" ? { idToken: tokens.id_token } : {}),
    },
  };
}

export const forgetPluginNotifications = (name: string) => void notified.delete(name);
