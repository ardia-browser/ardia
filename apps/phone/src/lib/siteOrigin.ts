const DEFAULT_PORTS: Record<string, string> = { http: "80", https: "443" };

export function siteOrigin(address: string | null | undefined): string | null {
  if (!address) return null;
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)/i.exec(address.trim());
  if (!match) return null;
  const scheme = match[1]!.toLowerCase();
  const authority = match[2]!.slice(match[2]!.lastIndexOf("@") + 1).toLowerCase();
  const bracketEnd = authority.lastIndexOf("]");
  const colon = authority.lastIndexOf(":");
  const hasPort = colon > bracketEnd;
  const host = hasPort ? authority.slice(0, colon) : authority;
  const port = hasPort ? authority.slice(colon + 1) : "";
  if (!host) return null;
  return port && port !== DEFAULT_PORTS[scheme] ? `${scheme}://${host}:${port}` : `${scheme}://${host}`;
}
