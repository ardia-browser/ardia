import { nativeModule } from "@ardia/shell";
import { t } from "../lib/uiLanguage";


export { completeInline, copyFieldAs, translation } from "@ardia/shell";

export const startDictation = () => nativeModule(t(`ArdiaShell`)).startDictation();
export const dictationAvailable = () => nativeModule(t(`ArdiaShell`)).dictationAvailable?.() !== false;
