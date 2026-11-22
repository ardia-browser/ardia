import { canonicalIpv6, formatUrl, urlParts } from "./urlParts";
import { t } from "./uiLanguage";


export const MAX_OPEN_URL_LENGTH = 2048;

const AUTHORITY = /^([A-Za-z][A-Za-z\d+.-]*:\/\/)([^/?#]*)(.*)$/s;
const NON_ASCII = /[^\x00-\x7f]+/gu;

export type PluginWebUrl = { url: string; host: string } | { problem: string };

function withCanonicalHost(raw: string, authority: string): string | null {
  if (!authority.startsWith("[")) return raw;
  const close = authority.indexOf("]");
  const canonical = close < 0 ? null : canonicalIpv6(authority.slice(1, close).toLowerCase());
  if (!canonical) return null;
  const found = AUTHORITY.exec(raw)!;
  return `${found[1]}[${canonical}]${authority.slice(close + 1)}${found[3]}`;
}

export function pluginWebUrl(raw: unknown): PluginWebUrl {
  if (typeof raw !== "string") return { problem: t(`isn't text`) };
  if (raw.length > MAX_OPEN_URL_LENGTH) return { problem: `is over ${MAX_OPEN_URL_LENGTH} characters` };
  if (/[\u0000-\u001f\u007f-\u009f]/.test(raw)) return { problem: t(`has a control character`) };
  if (/\s/u.test(raw)) return { problem: t(`has a space; percent-encode it as %20`) };
  if (raw.includes("\\")) return { problem: t(`has a backslash`) };
  const found = AUTHORITY.exec(raw);
  if (!found || !/^https?:\/\/$/i.test(found[1]!)) return { problem: t(`isn't an http or https address with a host`) };
  if (/[^\x00-\x7f]/.test(found[2]!)) return { problem: t(`has a host that isn't ASCII; send an international name as punycode (xn--)`) };
  if (found[2]!.includes("@")) return { problem: t(`has credentials`) };
  const plain = withCanonicalHost(raw, found[2]!);
  const parts = plain === null ? null : urlParts(plain);
  if (!parts || !parts.authority || !parts.host) return { problem: t(`isn't a valid address (check the host and that the port is 1 to 65535)`) };
  try {
    return { url: formatUrl(parts).replace(NON_ASCII, (run) => encodeURIComponent(run)), host: parts.host };
  } catch {
    return { problem: t(`has text that isn't valid Unicode`) };
  }
}
