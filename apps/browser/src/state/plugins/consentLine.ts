export type ConsentGroup = "reaches" | "limits" | "does";

export type ConsentLine = {
  icon: string;
  group: ConsentGroup;
  title: string;
  detail?: string;
  items?: readonly string[];
  code?: boolean;
  text: string;
};

export const CONSENT_GROUP_TITLES: Readonly<Record<ConsentGroup, string>> = { reaches: "What It Can Reach", limits: "Safeguards", does: "What It Does" };

export const CONSENT_GROUP_ORDER: readonly ConsentGroup[] = ["reaches", "limits", "does"];

export const listed = (items: readonly string[]) => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

type More = { detail?: string; items?: readonly string[]; code?: boolean };

export function consentLine(group: ConsentGroup, icon: string, title: string, more: More = {}): ConsentLine {
  const items = more.items?.length ? more.items : undefined;
  const text = `${title}${items ? `: ${listed(items)}` : ""}${more.detail ? `. ${more.detail}` : ""}`;
  return { icon, group, title, text, ...(more.detail ? { detail: more.detail } : {}), ...(items ? { items, ...(more.code ? { code: true } : {}) } : {}) };
}

export const groupedConsent = (lines: readonly ConsentLine[]) => CONSENT_GROUP_ORDER.map((group) => ({ group, title: CONSENT_GROUP_TITLES[group], lines: lines.filter((l) => l.group === group) })).filter((g) => g.lines.length > 0);
