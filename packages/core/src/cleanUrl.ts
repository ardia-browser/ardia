
const GLOBAL_PARAMS = new Set([
  "gclid", "gclsrc", "dclid", "gbraid", "wbraid", "gad_source", "gad_campaignid", "_ga", "_gl", "srsltid",
  "fbclid", "igshid", "msclkid", "twclid", "ttclid", "li_fat_id", "yclid", "ysclid", "rdt_cid", "epik",
  "mc_cid", "mc_eid", "_hsenc", "_hsmi", "__hssc", "__hstc", "__hsfp", "hsctatracking", "mkt_tok", "elqtrackid",
  "elqtrack", "vero_id", "vero_conv", "_kx", "__s",
  "oly_anon_id", "oly_enc_id", "_openstat", "wickedid", "rb_clickid", "s_cid", "irclickid", "cjevent", "sscid",
  "zanpid", "ranmid", "raneaid", "ransiteid", "trk_contact", "trk_msg", "trk_module", "trk_sid",
]);

const GLOBAL_PREFIXES = ["utm_", "pk_", "mtm_", "piwik_", "matomo_", "hsa_", "stm_"];

const SITE_PARAMS: { hosts: string[]; params: string[]; prefixes?: string[] }[] = [
  { hosts: ["youtube.com", "youtu.be", "music.youtube.com"], params: ["si", "pp", "feature"] },
  { hosts: ["open.spotify.com"], params: ["si", "nd", "context"] },
  { hosts: ["instagram.com"], params: ["igsh", "img_index"] },
  { hosts: ["x.com", "twitter.com"], params: ["s", "t", "ref_src", "ref_url"] },
  { hosts: ["threads.net", "threads.com"], params: ["xmt", "slof"] },
  { hosts: ["tiktok.com"], params: ["is_from_webapp", "sender_device", "sender_web_id", "_r", "_t"] },
  { hosts: ["linkedin.com"], params: ["trk", "trackingid", "lipi", "midtoken", "midsig", "trkemail", "eid"] },
  { hosts: ["reddit.com"], params: ["share_id", "ref_source", "ref_campaign"] },
  { hosts: ["medium.com"], params: ["source"] },
  { hosts: ["facebook.com"], params: ["mibextid", "sfnsn", "rdid", "share_url"] },
  {
    hosts: ["amazon.com", "amazon.co.uk", "amazon.de", "amazon.fr", "amazon.it", "amazon.es", "amazon.ca", "amazon.co.jp", "amazon.in", "amazon.com.au"],
    params: ["_encoding", "psc", "ref", "ref_", "tag", "linkcode", "linkid", "camp", "creative", "creativeasin", "content-id", "crid", "sprefix", "qid", "sr", "dib", "dib_tag"],
    prefixes: ["pd_rd_", "pf_rd_"],
  },
];

function siteRules(hostname: string) {
  const host = hostname.toLowerCase().replace(/^www\./, "");
  return SITE_PARAMS.filter((r) => r.hosts.some((h) => host === h || host.endsWith(`.${h}`)));
}

function decodeName(raw: string): string {
  try {
    return decodeURIComponent(raw.replace(/\+/g, " ")).toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}

function isTrackingParam(name: string, hostname = ""): boolean {
  const key = name.toLowerCase();
  if (GLOBAL_PARAMS.has(key) || GLOBAL_PREFIXES.some((p) => key.startsWith(p))) return true;
  return siteRules(hostname).some((r) => r.params.includes(key) || r.prefixes?.some((p) => key.startsWith(p)));
}

export type CleanedUrl = string & { readonly trackersStripped: unique symbol };
export type LinkText = CleanedUrl | (string & { readonly linksTrackersStripped: unique symbol });
type CleanUrlReport = { readonly url: CleanedUrl; readonly removedTracker: boolean };

export function cleanUrlReport(url: string): CleanUrlReport {
  const unchanged = Object.freeze({ url: url as CleanedUrl, removedTracker: false });
  const match = /^([^?#]*)(\?[^#]*)?(#.*)?$/.exec(url);
  if (!match?.[2]) return unchanged;
  let hostname = "";
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return unchanged;
    hostname = parsed.hostname;
  } catch {
    return unchanged;
  }
  const [, base = "", query = "", hash = ""] = match;
  const pairs = query.slice(1).split("&");
  const tracks = (pair: string) => isTrackingParam(decodeName(pair.split("=")[0]!), hostname);
  const kept = pairs.filter((pair) => pair && !tracks(pair));
  if (kept.length === pairs.length) return unchanged;
  const cleaned = `${base}${kept.length ? `?${kept.join("&")}` : ""}${hash}` as CleanedUrl;
  return Object.freeze({ url: cleaned, removedTracker: pairs.some((pair) => pair !== "" && tracks(pair)) });
}

export function cleanUrl(url: string): CleanedUrl {
  return cleanUrlReport(url).url;
}

const LINE_BREAK_ESCAPES: Record<string, string> = { "\r": "%0D", "\n": "%0A" };

const markdownLabel = (text: string) => text.replace(/[\\[\]*_\x60<>~]/g, "\\$&").replace(/&(?=#?[A-Za-z0-9]+;)/g, "&amp;");

function markdownDestination(url: string): string {
  const oneLine = url.replace(/[\r\n]/g, (character) => LINE_BREAK_ESCAPES[character]!).replace(/&(?=#?[A-Za-z0-9]+;)/g, "&amp;");
  return /[\s<>]/.test(oneLine) ? `<${oneLine.replace(/[<>\\]/g, "\\$&")}>` : oneLine.replace(/[()\\]/g, "\\$&");
}

export type CleanedTitle = string & { readonly titleTrackersStripped: unique symbol };

export function cleanLinkTitle(title: string | null | undefined, url: string): CleanedTitle {
  const oneLine = (title ?? "").replace(/\s*[\r\n\u2028\u2029]+\s*/g, " ").trim();
  if (!oneLine) return "" as CleanedTitle;
  return (oneLine === url.trim() ? cleanUrl(url) : cleanUrl(oneLine)) as string as CleanedTitle;
}

export function markdownLink(title: string, url: string): LinkText {
  const clean = cleanUrl(url);
  return `[${markdownLabel(cleanLinkTitle(title, url) || clean)}](${markdownDestination(clean)})` as LinkText;
}

export function linkLines(lines: readonly LinkText[], markdown: boolean): LinkText {
  return (markdown && lines.length > 1 ? lines.map((line) => `- ${line}`).join("\n") : lines.join("\n")) as LinkText;
}
