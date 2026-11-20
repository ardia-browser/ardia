import { PINNED_TOAST, receivedToast, sentToast } from "../sync/syncRules.ts";
import type { ToastIcon } from "../toasts/store.ts";

export type SampleToast = { message: string; icon: ToastIcon };

const SAMPLE_DEVICE = "MacBook Pro";

export function sampleToast(name: string): SampleToast | null {
  switch (name) {
    case "copied":
      return { message: "Copied URL", icon: "link" };
    case "cleared":
      return { message: "Cleared Browsing Data", icon: "checkmark" };
    case "received":
      return { message: receivedToast(SAMPLE_DEVICE, 1), icon: "laptop" };
    case "receivedSeveral":
      return { message: receivedToast(SAMPLE_DEVICE, 3), icon: "laptop" };
    case "sent":
      return { message: sentToast(SAMPLE_DEVICE), icon: "sent" };
    case "pinned":
      return { message: PINNED_TOAST, icon: "star" };
    default:
      return null;
  }
}

export const DEMO_PRIVATE_URLS = ["https://en.wikipedia.org/wiki/Moon", "https://www.apple.com/"] as const;

export const manyTabTitle = (index: number) =>
  index % 7 === 0 ? `An exceptionally long article title that keeps going well past eighty characters to test truncation ${index}` : `Article ${index + 1}`;
