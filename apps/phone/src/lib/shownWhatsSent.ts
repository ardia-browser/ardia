import { PHONE_SHARING_COPY, PHONE_WHATS_SENT, type SentItem } from "./telemetryCopy.ts";

const SYNC_ONLY_PHRASES = ["pages you pinned to your Mac, ", "tabs you sent to another device, "];

const APPEARANCE_WITHOUT_SYNC = "With each launch, the Appearance you chose: Glass or Classic, and Light, Dark or System";

const IPHONE_ONLY_FIELDS = ["perf_backdrop", "browse_for_me_opened", "page_summaries_pinched"];

const ANDROID_ONLY_FIELDS = ["page_summaries_chatgpt", "start_logo_taps"];

const shownOn = (os: string, item: SentItem) => !(os === "ios" ? ANDROID_ONLY_FIELDS : IPHONE_ONLY_FIELDS).some((field) => item.fields.includes(field));

function shownItem(item: SentItem, offersSync: boolean): SentItem {
  if (offersSync) return item;
  if (item.fields.includes("interface_style")) return { ...item, text: APPEARANCE_WITHOUT_SYNC };
  return { ...item, text: SYNC_ONLY_PHRASES.reduce((text, phrase) => text.replace(phrase, ""), item.text) };
}

export function shownWhatsSent(os: string, offersSync: boolean): { title: string; items: SentItem[] }[] {
  return PHONE_WHATS_SENT.map((section) => ({
    title: section.title,
    items: section.items.filter((item) => shownOn(os, item)).map((item) => shownItem(item, offersSync)),
  }));
}

export const shownSharingFootnote = (offersSync: boolean) => (offersSync ? PHONE_SHARING_COPY.footnote : PHONE_SHARING_COPY.footnote.replace(" This setting doesn’t sync.", ""));
