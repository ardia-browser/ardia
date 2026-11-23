import { cleanLinkTitle, cleanUrl } from "@ardia/core";
import { mailtoLink, shareLink, shareLinkVia } from "./linkShare.ts";

const raw: string = "https://shop.example/item?id=7&utm_source=mail";

export function rawStringsAreRefusedAtLinuxShareSinks() {
  // @ts-expect-error
  void shareLink(raw, null, null);
  // @ts-expect-error
  void shareLinkVia("email", raw, null, null);
  // @ts-expect-error
  void mailtoLink(raw, null);
  // @ts-expect-error
  void shareLink(cleanUrl(raw), raw, null);
  // @ts-expect-error
  void shareLinkVia("email", cleanUrl(raw), raw, null);
  // @ts-expect-error
  return mailtoLink(cleanUrl(raw), raw);
}

export function cleanedUrlsReachLinuxShareSinks() {
  void shareLink(cleanUrl(raw), cleanLinkTitle("Title", raw), null);
  void shareLinkVia("email", cleanUrl(raw), cleanLinkTitle(raw, raw), null);
  return mailtoLink(cleanUrl(raw), cleanLinkTitle(raw, raw));
}
