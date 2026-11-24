import { cleanUrlReport } from "@ardia/core/src/mobile.ts";
import { copiedLinkWords } from "../../lib/sharedWords.ts";

export function linkToCopy(url: string) {
  const cleaned = cleanUrlReport(url);
  return { text: cleaned.url, acknowledgement: copiedLinkWords(cleaned.removedTracker) };
}
