import type { PageSummaryProvider } from "../../platform/pages";
import { t } from "../../lib/uiLanguage";


export const PAGE_SUMMARY_COPY = {
  title: t(`Pinch to Summarize`),
  subtitle: t(`Pinch in on a page, or choose Summarize Page in the page menu, for a short summary over the page you’re reading.`),
  onDevice: t(`On This Phone`),
  onDeviceDetail: t(`Gemini Nano, on phones that have it`),
  chatGPT: t(`ChatGPT`),
  chatGPTDetail: t(`Your ChatGPT Plus or Pro plan`),
  onDeviceFooter: t(`The page’s text stays on this phone.`),
  chatGPTFooter:
    t(`Choosing ChatGPT sends the text Ardia extracts from each page you summarize, Incognito pages included, straight from this phone to OpenAI on your plan, never through a server of ours. Usage counts toward your ChatGPT limits.`),
  offFooter: t(`Off until you turn it on. Ardia reads a page only when you pinch in or choose Summarize Page.`),
  iPhoneFooter: t(`Pinch to Summarize writes a short summary on this iPhone when you pinch in on a page or choose Summarize Page in the page menu.`),
  reconnect: t(`ChatGPT isn’t connected, so summaries stay on this phone until you connect it again.`),
} as const;

export const pageSummaryRowValue = (enabled: boolean, provider: PageSummaryProvider, connected: boolean) =>
  !enabled ? t(`Off`) : provider === "chatgpt" ? (connected ? PAGE_SUMMARY_COPY.chatGPT : t(`ChatGPT, Not Connected`)) : PAGE_SUMMARY_COPY.onDevice;
