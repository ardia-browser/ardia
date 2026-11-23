import type { VaultPasswordStyle } from "../../state/vaults/types";
import { brandOf } from "../../state/vaults/brands";
import type { VaultRow } from "../../state/vaults/menuModel";
import { siteKey, siteLabel } from "../../state/vaults/originMatch";

const withScheme = (url: string) => (!url || /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`);
export const itemUrl = (item: { urls: readonly string[] }) => withScheme(item.urls[0] ?? "");
export const itemSite = (urls: readonly string[]) => (urls[0] ? siteLabel(withScheme(urls[0])) : "");

export const GENERATOR_COPY: Record<VaultPasswordStyle, { title: string; detail?: string }> = {
  strong: { title: "New Strong Password" },
  alphanumeric: { title: "New Strong Password", detail: "Without Special Characters" },
  easyToType: { title: "New Strong Password", detail: "Easy to Type" },
  passphrase: { title: "New Strong Password", detail: "Easy to Remember" },
};

function hostOnPage(urls: readonly string[], site: string) {
  const hosts = urls.map((url) => siteLabel(withScheme(url)));
  if (hosts.includes(site)) return site;
  const page = siteKey(withScheme(site));
  return hosts.find((host) => siteKey(withScheme(host)) === page) ?? hosts[0] ?? "";
}

type LoginItem = Extract<VaultRow, { kind: "login" }>["item"];

function plainLines(item: LoginItem, site: string) {
  const where = hostOnPage(item.urls, site) || site;
  if (item.passkey) return { title: item.username || item.title || where, detail: `Passkey for ${where}` };
  return { title: item.username || item.title || where, detail: item.username || item.title ? where : "" };
}

export function loginLines(item: LoginItem, site: string, twin = false) {
  const lines = plainLines(item, site);
  return twin && item.title && item.title !== lines.title ? { title: lines.title, detail: item.title } : lines;
}

export function twinLogins(rows: readonly VaultRow[], site: string): ReadonlySet<string> {
  const seen = new Map<string, string[]>();
  for (const row of rows) {
    if (row.kind !== "login") continue;
    const { title, detail } = plainLines(row.item, site);
    const same = `${title}\n${detail}`;
    seen.set(same, [...(seen.get(same) ?? []), row.key]);
  }
  return new Set([...seen.values()].filter((keys) => keys.length > 1).flat());
}

export function rowLabel(row: VaultRow, site: string, twin = false): string {
  switch (row.kind) {
    case "login": {
      const { title, detail } = loginLines(row.item, site, twin);
      return [title, detail, brandOf(row.item.provider).name].filter(Boolean).join(", ");
    }
    case "otp":
      return `Verification Code, ${row.item.username || row.item.title || itemSite(row.item.urls)}`;
    case "username":
      return `${row.username}, Used Before`;
    case "generate": {
      const copy = GENERATOR_COPY[row.style];
      return [copy.title, copy.detail].filter(Boolean).join(", ");
    }
    case "unlock":
      return `Unlock ${row.name}`;
    case "allPasswords":
      return "Other Passwords…";
    case "suggest":
      return "Suggest New Password";
    case "openPasswords":
      return "Open Passwords…";
    case "settings":
      return "Password Settings…";
  }
}
