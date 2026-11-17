import { PHONE_SHARING_COPY, PHONE_WHATS_SENT, type SentItem } from "./telemetryCopy.ts";

const SYNC_ONLY_PHRASES = ["pages you pinned to your Mac, ", "tabs you sent to another device, "];

const APPEARANCE_WITHOUT_SYNC = "With each launch, the Appearance you chose: Glass or Classic, and Light, Dark or System";

const IPHONE_ONLY_FIELD = "perf_backdrop";

function shownItem(item: SentItem, offersSync: boolean): SentItem {
  if (offersSync) return item;
  if (item.fields.includes("interface_style")) return { ...item, text: APPEARANCE_WITHOUT_SYNC };
  return { ...item, text: SYNC_ONLY_PHRASES.reduce((text, phrase) => text.replace(phrase, ""), item.text) };
}

export function shownWhatsSent(os: string, offersSync: boolean): { title: string; items: SentItem[] }[] {
  return PHONE_WHATS_SENT.map((section) => ({
    title: section.title,
    items: section.items.filter((item) => os === "ios" || !item.fields.includes(IPHONE_ONLY_FIELD)).map((item) => shownItem(item, offersSync)),
  }));
}

export const shownSharingFootnote = (offersSync: boolean) => (offersSync ? PHONE_SHARING_COPY.footnote : PHONE_SHARING_COPY.footnote.replace(" This setting doesn’t sync.", ""));
