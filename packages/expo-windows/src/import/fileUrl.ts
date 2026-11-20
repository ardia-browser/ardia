export function pathFromFileUrl(picked: string): string {
  if (!picked.startsWith("file:")) return picked;
  const decoded = decodeURIComponent(picked);
  const local = /^file:\/\/\/([A-Za-z]:.*)$/.exec(decoded);
  if (local) return local[1]!.replace(/\//g, "\\");
  const network = /^file:\/\/([^/].*)$/.exec(decoded);
  if (network) return `\\\\${network[1]!.replace(/\//g, "\\")}`;
  return decoded.replace(/^file:\/*/, "").replace(/\//g, "\\");
}
