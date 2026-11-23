import { cleanLinkTitle, cleanUrl, linkLines } from "@ardia/core/src/cleanUrl.ts";
import { pages } from "@ardia/phone-native";
import { copyLink, copyText, shareLink, shareLinkList, sharePageWithPrint } from "./system";

const raw: string = "https://shop.example/item?id=7&utm_source=mail";

export function rawStringsAreRefusedAtLinkSinks() {
  // @ts-expect-error
  void copyLink(raw);
  // @ts-expect-error
  void shareLink(raw, "Title");
  // @ts-expect-error
  void sharePageWithPrint("page", raw, "Title");
  // @ts-expect-error
  void pages.sharePage("page", raw, "Title");
  // @ts-expect-error
  void shareLinkList([raw, raw].join("\n"), "Open Tabs");
  // @ts-expect-error
  void shareLink(cleanUrl(raw), raw);
  // @ts-expect-error
  void sharePageWithPrint("page", cleanUrl(raw), raw);
  // @ts-expect-error
  void pages.sharePage("page", cleanUrl(raw), raw);
}

export function cleanedUrlsReachLinkSinks() {
  void copyLink(cleanUrl(raw));
  void shareLink(cleanUrl(raw), cleanLinkTitle(raw, raw));
  void sharePageWithPrint("page", cleanUrl(raw), cleanLinkTitle("Title", raw));
  void pages.sharePage("page", cleanUrl(raw), cleanLinkTitle("Title", raw));
  void shareLinkList(linkLines([cleanUrl(raw), cleanUrl(raw)], false), "Open Tabs");
  void copyText("42");
}
