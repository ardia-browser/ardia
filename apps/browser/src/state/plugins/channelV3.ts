import type { PluginManifest } from "../../lib/pluginManifest";
import type { Body } from "../automation/controlSocket";
import { bookmarksMethod, historyMethod, intentMethod, mediaMethod, profilesMethod } from "./browserApis";
import { cancelStream, closeSocket, connectSocket, fetchStream, sendSocket } from "./netChannels";
import { clipboardMethod, notifyMethod, signIn } from "./osApis";
import { filesMethod } from "./fileApis";
import { pageMethod } from "./pageApis";
import { servicesMethod } from "./services";
import { sidecarMethod } from "./sidecarPipe";

type Caller = { name: string; run: number };

const PREFIXED: [string, (c: Caller, m: PluginManifest, method: string, params: Record<string, unknown>) => Body | Promise<Body>][] = [
  ["services.", servicesMethod],
  ["sidecar.", sidecarMethod],
  ["page.", pageMethod],
  ["bookmarks.", bookmarksMethod],
  ["history.", historyMethod],
  ["profiles.", profilesMethod],
  ["media.", mediaMethod],
  ["clipboard.", clipboardMethod],
  ["fs.", filesMethod],
];

export const V3_METHODS = [
  "net.fetch.stream",
  "net.fetch.cancel",
  "net.ws.connect",
  "net.ws.send",
  "net.ws.close",
  "auth.signIn",
  "services.provide",
  "services.withdraw",
  "services.list",
  "services.call",
  "sidecar.send",
  "sidecar.request",
  "page.readActive",
  "page.readTab",
  "page.sendToContent",
  "bookmarks.list",
  "bookmarks.search",
  "bookmarks.create",
  "bookmarks.update",
  "bookmarks.remove",
  "history.search",
  "history.recent",
  "profiles.list",
  "profiles.current",
  "profiles.switch",
  "media.sessions",
  "media.control",
  "splits.open",
  "peek.open",
  "clipboard.readText",
  "clipboard.writeText",
  "fs.pickFiles",
  "fs.saveFile",
  "fs.readChunk",
  "fs.closeFile",
  "fs.saveBegin",
  "fs.saveChunk",
  "fs.saveCommit",
  "ui.notify",
] as const;

const KNOWN = new Set<string>(V3_METHODS);

export function answerV3Method(c: Caller, m: PluginManifest, method: string, params: Record<string, unknown>): Body | Promise<Body> | null {
  if (!KNOWN.has(method)) return null;
  switch (method) {
    case "net.fetch.stream":
      return fetchStream(c, m, params);
    case "net.fetch.cancel":
      return cancelStream(c, params);
    case "net.ws.connect":
      return connectSocket(c, m, params);
    case "net.ws.send":
      return sendSocket(c, params);
    case "net.ws.close":
      return closeSocket(c, params);
    case "auth.signIn":
      return signIn(c, m, params);
    case "splits.open":
    case "peek.open":
      return intentMethod(c, m, method, params);
    case "ui.notify":
      return notifyMethod(c, m, params);
  }
  const handler = PREFIXED.find(([prefix]) => method.startsWith(prefix))?.[1];
  return handler ? handler(c, m, method, params) : null;
}
