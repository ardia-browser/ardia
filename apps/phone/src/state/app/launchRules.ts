import { PINNED_TOAST, receivedToast, sentToast } from "../sync/syncRules.ts";
import type { ToastCard } from "../toasts/store.ts";
import { actionWords } from "../../lib/sharedWords.ts";
import { CLEARED_TOAST } from "../settings/settingsRules.ts";
import { DOWNLOAD_FAILURE_WHY, downloadedDetail, downloadFailedToast, downloadsCompleteDetail, downloadsCompleteTitle } from "../page/pagePrompts.ts";

export type SampleToast = ToastCard;

const SAMPLE_FILE = "ok-report.pdf";
const noop = () => undefined;

const SAMPLE_DEVICE = "MacBook Pro";

export function sampleToast(name: string): SampleToast | null {
  switch (name) {
    case "copied":
      return { title: actionWords.copiedLink, icon: "link" };
    case "cleared":
      return { title: CLEARED_TOAST, detail: "History, Cache, and Cookies · Last Hour", icon: "checkmark" };
    case "received":
      return { title: receivedToast(SAMPLE_DEVICE, 1), icon: "laptop" };
    case "receivedSeveral":
      return { title: receivedToast(SAMPLE_DEVICE, 3), icon: "laptop" };
    case "sent":
      return { title: sentToast(SAMPLE_DEVICE), detail: "example.com", icon: "sent" };
    case "pinned":
      return { title: PINNED_TOAST, icon: "star" };
    case "downloaded":
      return { key: "sample:download", title: SAMPLE_FILE, detail: downloadedDetail(1_234_567, "127.0.0.1"), tile: { kind: "file", ext: "pdf" }, icon: "download", action: { label: actionWords.open, run: noop }, stage: "done" };
    case "downloadFailed":
      return { key: "sample:download", title: downloadFailedToast("quarterly-report.pdf"), detail: DOWNLOAD_FAILURE_WHY.server, tile: { kind: "icon", icon: "warning" }, icon: "warning", action: { label: actionWords.retry, run: noop }, titleLines: 2, stage: "failed" };
    case "downloadsGrouped":
      return { key: "sample:download", title: downloadsCompleteTitle(2), detail: downloadsCompleteDetail([SAMPLE_FILE, "b.zip"]), tile: { kind: "count", count: 2 }, icon: "download", action: { label: actionWords.show, run: noop }, stage: "group:2" };
    default:
      return null;
  }
}

export const DEMO_PRIVATE_URLS = ["https://en.wikipedia.org/wiki/Moon", "https://www.apple.com/"] as const;

export const manyTabTitle = (index: number) =>
  index % 7 === 0 ? `An exceptionally long article title that keeps going well past eighty characters to test truncation ${index}` : `Article ${index + 1}`;
