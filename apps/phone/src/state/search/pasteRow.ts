import type { Counted } from "../../lib/telemetrySchema.ts";
import type { TrayRow } from "./omnibox.ts";
import { t } from "../../lib/uiLanguage";


export type PasteOffer = "link" | "text";

export const PASTE_ROW_KEY = "paste";

export function withPasteRow(rows: TrayRow[], typed: string, offer: PasteOffer | null): TrayRow[] {
  if (typed.trim() || !offer) return rows;
  const detail = offer === "link" ? t(`Link You Copied`) : t(`Text You Copied`);
  return [{ key: PASTE_ROW_KEY, kind: "paste", title: t(`Paste and Go`), detail, url: "", offer }, ...rows];
}

export type PasteTap = { go: string | null; count: Counted };

export function pasteTap(pasted: string | null | undefined, opensAddress: (text: string) => boolean): PasteTap {
  const text = pasted?.trim() ?? "";
  if (!text) return { go: null, count: "paste_and_go_unread" };
  return { go: text, count: opensAddress(text) ? "paste_and_go_links" : "paste_and_go_texts" };
}
