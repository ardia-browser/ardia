import { create } from "zustand";
import { pages, type PageSummaryProvider } from "../../platform/pages";
import { connectChatGPT } from "../browseForMe/store";
import { settled } from "../pages/store";

export const usePageSummary = create<{ provider: PageSummaryProvider }>()(() => ({ provider: "on_device" }));

export const usePageSummaryProvider = () => usePageSummary((state) => state.provider);

export function pageSummaryChoiceOffered(): boolean {
  try {
    return pages.choosesSummaryProvider();
  } catch {
    return false;
  }
}

let selection = 0;

export async function refreshPageSummaryProvider() {
  if (!pageSummaryChoiceOffered()) return;
  const current = selection;
  const provider = await settled(() => pages.summaryProvider(), usePageSummary.getState().provider);
  if (current === selection) usePageSummary.setState({ provider });
}

async function saveProvider(provider: PageSummaryProvider, current: number): Promise<boolean> {
  const saved = await settled(() => pages.setSummaryProvider(provider), usePageSummary.getState().provider);
  if (current !== selection) return false;
  usePageSummary.setState({ provider: saved });
  return saved === provider;
}

export async function choosePageSummaryProvider(provider: PageSummaryProvider) {
  if (!pageSummaryChoiceOffered()) return;
  await saveProvider(provider, ++selection);
}

export async function choosePageSummaryChatGPT(connected: boolean): Promise<boolean> {
  if (!pageSummaryChoiceOffered()) return false;
  const current = ++selection;
  if (!connected && !(await connectChatGPT())) return false;
  return current === selection && saveProvider("chatgpt", current);
}
