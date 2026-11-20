const EFFORT_NAMES: Record<string, string> = { none: "None", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra High" };

export const chatGPTEffortName = (effort: string) => EFFORT_NAMES[effort] ?? effort.charAt(0).toUpperCase() + effort.slice(1);

export const browseForMeSubtitle = (connected: boolean) =>
  connected
    ? "Answers come from your ChatGPT plan. When it can’t answer, Gemini Nano writes them on this phone if it can, or you get the most relevant lines from the pages."
    : "Answers are written on this phone by Gemini Nano where your phone has it, or built from the most relevant lines of the pages. Connect ChatGPT Plus or Pro for better answers from your own plan.";

export const browseForMeRowValue = (connected: boolean) => (connected ? "ChatGPT" : "On This Phone");
