import { t } from "../../lib/uiLanguage";
const EFFORT_NAMES: Record<string, string> = { none: t(`None`), minimal: t(`Minimal`), low: t(`Low`), medium: t(`Medium`), high: t(`High`), xhigh: t(`Extra High`) };

export const chatGPTEffortName = (effort: string) => EFFORT_NAMES[effort] ?? effort.charAt(0).toUpperCase() + effort.slice(1);

export const browseForMeSubtitle = (connected: boolean) =>
  connected
    ? t(`Answers come from your ChatGPT plan. When it can’t answer, Gemini Nano writes them on this phone if it can, or you get the most relevant lines from the pages.`)
    : t(`Answers are written on this phone by Gemini Nano where your phone has it, or built from the most relevant lines of the pages. Connect ChatGPT Plus or Pro for better answers from your own plan.`);

export const browseForMeRowValue = (connected: boolean) => (connected ? t(`ChatGPT`) : t(`On This Phone`));
