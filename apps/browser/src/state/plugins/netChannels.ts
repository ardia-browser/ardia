import type { PluginManifest } from "../../lib/pluginManifest";
import { cancelPluginStream, closePluginNet, closePluginSocket, connectPluginSocket, sendPluginSocket, startPluginStream } from "../../platform/plugins";
import { failure } from "../automation/automationMethods";
import type { Body } from "../automation/controlSocket";
import { notePlugin } from "../telemetry/pluginCounts";
import { consentToken } from "../telemetry/choice";
import { fetchRequestOf, headersOf, targetOf } from "./netRequest";

type Caller = { name: string; run: number };

const CHANNEL_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const NET_CHANNEL_LIMITS = { streams: 8, sockets: 8, protocols: 8, messageBytes: 1024 * 1024 } as const;

const idOf = (value: unknown) => (typeof value === "string" && CHANNEL_ID.test(value) ? value : null);

export async function fetchStream(c: Caller, m: PluginManifest, params: Record<string, unknown>): Promise<Body> {
  const stream = idOf(params.stream);
  if (!stream) return failure("bad_request", "net.fetch.stream needs a stream id of up to 64 letters, digits, - and _.");
  const consent = consentToken();
  const request = fetchRequestOf(m, params, "net.fetch.stream");
  if ("code" in request) return failure(request.code, request.message);
  notePlugin("plugin_net_streams", consent);
  const head = await startPluginStream({ ...request, name: c.name, run: c.run, stream }).catch((error: unknown) => ({ ok: false as const, reason: String(error) }));
  if (!head.ok) {
    notePlugin("plugin_net_stream_failures", consent);
    return failure("failed", head.reason);
  }
  const { ok: _ok, ...shown } = head;
  return { result: shown };
}

export function cancelStream(c: Caller, params: Record<string, unknown>): Body {
  const stream = idOf(params.stream);
  if (!stream) return failure("bad_request", "net.fetch.cancel needs the stream id.");
  cancelPluginStream(c.name, c.run, stream);
  return { result: { ok: true } };
}

function protocolsOf(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > NET_CHANNEL_LIMITS.protocols) return null;
  return value.every((p) => typeof p === "string" && /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/.test(p)) ? (value as string[]) : null;
}

export async function connectSocket(c: Caller, m: PluginManifest, params: Record<string, unknown>): Promise<Body> {
  const socket = idOf(params.socket);
  if (!socket) return failure("bad_request", "net.ws.connect needs a socket id of up to 64 letters, digits, - and _.");
  const consent = consentToken();
  const target = targetOf(m, params.url, "net.ws.connect", true);
  if ("code" in target) return failure(target.code, target.message);
  const protocols = protocolsOf(params.protocols);
  if (!protocols) return failure("bad_request", `protocols is a list of up to ${NET_CHANNEL_LIMITS.protocols} tokens.`);
  const headers = headersOf(params.headers);
  if (typeof headers === "string") return failure("bad_request", headers);
  notePlugin("plugin_net_sockets", consent);
  const opened = await connectPluginSocket({ name: c.name, run: c.run, socket, url: target.url, protocols, headers, allowedHosts: target.allowedHosts }).catch((error: unknown) => ({ ok: false as const, reason: String(error) }));
  if (!opened.ok) {
    notePlugin("plugin_net_socket_failures", consent);
    return failure("failed", opened.reason);
  }
  return { result: { open: opened.open, protocol: opened.protocol } };
}

export async function sendSocket(c: Caller, params: Record<string, unknown>): Promise<Body> {
  const socket = idOf(params.socket);
  if (!socket) return failure("bad_request", "net.ws.send needs the socket id.");
  if (typeof params.data !== "string") return failure("bad_request", "data is text; send binary as base64 with binary: true.");
  if (params.data.length > NET_CHANNEL_LIMITS.messageBytes * 2) return failure("bad_request", `A message is at most ${NET_CHANNEL_LIMITS.messageBytes / 1024 / 1024} MB.`);
  const sent = await sendPluginSocket(c.name, c.run, socket, params.data, params.binary === true).catch((error: unknown) => ({ ok: false as const, reason: String(error) }));
  return sent.ok ? { result: { ok: true } } : failure("failed", sent.reason);
}

export function closeSocket(c: Caller, params: Record<string, unknown>): Body {
  const socket = idOf(params.socket);
  if (!socket) return failure("bad_request", "net.ws.close needs the socket id.");
  const code = typeof params.code === "number" && Number.isInteger(params.code) && (params.code === 1000 || (params.code >= 3000 && params.code <= 4999)) ? params.code : 1000;
  const reason = typeof params.reason === "string" ? params.reason.slice(0, 123) : "";
  closePluginSocket(c.name, c.run, socket, code, reason);
  return { result: { ok: true } };
}

export function dropNetChannels(name: string) {
  closePluginNet(name, 0);
}
