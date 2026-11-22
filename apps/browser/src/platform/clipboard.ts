import { nativeModule } from "@ardia/shell";
import { t } from "../lib/uiLanguage";


const Shell = nativeModule(t(`ArdiaShell`));

export const copyText = (text: string) => Shell.copyText(text);
export const readText = () => Shell.readText();
