import { nativeModule } from "@ardia/shell";

export { completeInline, copyFieldAs, keepInlineWhileTyping, takeKeptInline, translation } from "@ardia/shell";

export const startDictation = () => nativeModule("ArdiaShell").startDictation();
export const dictationAvailable = () => nativeModule("ArdiaShell").dictationAvailable?.() !== false;
