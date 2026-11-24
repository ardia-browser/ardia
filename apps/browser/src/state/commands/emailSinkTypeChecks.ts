import { cleanLinkTitle, cleanUrl } from "@ardia/core";
import { emailPageLink } from "./commands";

const raw: string = "https://shop.example/item?id=7&utm_source=mail";

export function rawTitlesAreRefusedAtTheEmailSubject() {
  // @ts-expect-error
  return emailPageLink(raw, cleanUrl(raw));
}

export function cleanedTitlesReachTheEmailSubject() {
  return emailPageLink(cleanLinkTitle(raw, raw), cleanUrl(raw));
}
