const SCHEME = /^([a-z][a-z0-9+.-]*):/i;

export function cardHost(url: string): string | null {
  const scheme = SCHEME.exec(url)?.[1];
  if (!scheme) return null;
  let start = scheme.length + 1;
  if (!url.startsWith("//", start)) return null;
  start += 2;
  let end = start;
  while (end < url.length && !"/?#\\".includes(url[end]!)) end++;
  let authority = url.slice(start, end);
  const at = authority.lastIndexOf("@");
  if (at >= 0) authority = authority.slice(at + 1);
  const host = authority.startsWith("[") ? authority.slice(0, (authority.indexOf("]") > 0 ? authority.indexOf("]") : authority.length - 1) + 1) : authority.split(":")[0]!;
  const raw = host.toLowerCase().replace(/\.+$/, "");
  const shown = raw.startsWith("www.") ? raw.slice(4) : raw;
  return shown || null;
}

export function placeholderIndex(url: string, count: number): number {
  if (count <= 0) return 0;
  const key = cardHost(url) ?? url;
  let value = 5381;
  for (const character of key) value = (Math.imul(value, 33) + character.codePointAt(0)!) >>> 0;
  return value % count;
}

export type ReceivedFacts = { origin: string; receivedKey: string | null; created: number; lastActive: number };

export const isUnseenReceived = (tab: ReceivedFacts) => tab.origin === "sent" && tab.receivedKey !== null && tab.lastActive <= tab.created;
