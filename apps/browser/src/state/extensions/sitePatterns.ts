import { punycodeEncode } from "@ardia/core";
import { urlParts } from "../../lib/urlParts";

const MAX_SITE_LENGTH = 2048;
const SCHEME = /^([a-z][a-z0-9+.-]*):\/\//i;
const DOTTED = /^\d{1,3}(\.\d{1,3}){3}$/;

const LABEL = /^[\p{L}\p{M}\p{N}-]{1,63}$/u;

function asciiAuthority(authority: string): string | null {
  if (/^[\x00-\x7f]*$/.test(authority) || authority.startsWith("[")) return authority;
  const colon = authority.lastIndexOf(":");
  const host = (colon < 0 ? authority : authority.slice(0, colon)).normalize("NFC").toLowerCase().replace(/[\u3002\uff0e\uff61]/g, ".");
  if (/[\u200c\u200d]/.test(host) || host.normalize("NFKC") !== host) return null;
  const labels = host.split(".").map((label) => {
    if (/^[\x00-\x7f]*$/.test(label)) return label;
    if (!LABEL.test(label) || label.startsWith("-") || label.endsWith("-")) return null;
    const encoded = `xn--${punycodeEncode(label)}`;
    return encoded.length <= 63 ? encoded : null;
  });
  if (labels.some((label) => label === null)) return null;
  return `${labels.join(".")}${colon < 0 ? "" : authority.slice(colon)}`;
}

function portOf(authority: string): string | null {
  const after = authority.startsWith("[") ? authority.slice(authority.indexOf("]") + 1) : authority;
  const colon = after.indexOf(":");
  return colon < 0 ? null : after.slice(colon + 1);
}

export function extensionSitePattern(typed: string): string | null {
  const trimmed = typed.trim();
  if (!trimmed || trimmed.length > MAX_SITE_LENGTH || /\s/.test(trimmed)) return null;
  const given = SCHEME.exec(trimmed);
  const scheme = given ? given[1]!.toLowerCase() : "*";
  if (scheme !== "*" && scheme !== "http" && scheme !== "https") return null;
  let rest = given ? trimmed.slice(given[0].length) : trimmed;
  const wildcard = rest.startsWith("*.");
  if (wildcard) rest = rest.slice(2);
  const authority = asciiAuthority(rest.split(/[/?#]/)[0] ?? "");
  if (authority === null) return null;
  const port = portOf(authority);
  if (port !== null && (scheme === "*" || !/^[1-9]\d{0,4}$/.test(port) || Number(port) > 65535)) return null;
  const parts = urlParts(`${scheme === "*" ? "https" : scheme}://${authority}/`);
  if (!parts?.host) return null;
  if (wildcard && (parts.host.startsWith("[") || DOTTED.test(parts.host) || !parts.host.replace(/\.$/, "").includes("."))) return null;
  return `${scheme}://${wildcard ? "*." : ""}${parts.host}${port !== null ? `:${port}` : ""}/*`;
}

export const extensionSiteLabel = (pattern: string) => pattern.replace(/^\*:\/\//, "").replace(/\/\*$/, "");
