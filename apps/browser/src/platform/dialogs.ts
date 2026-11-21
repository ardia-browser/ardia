import { nativeModule, type ConfirmOptions, type PromptOptions } from "@ardia/shell";

const Dialogs = nativeModule("ArdiaDialogs");

export const confirm = (options: ConfirmOptions) => Dialogs.confirm(options);
export const canDismissShownOnlyDialogs = () => Dialogs.dismissesShownOnly === true;
export const dismissShownOnlyDialogs = async (key?: string) => {
  await Dialogs.dismissShownOnly?.(key ?? null);
};
export const prompt = (options: PromptOptions) => Dialogs.prompt(options);
export const pickFiles = () => Dialogs.pickFiles();
export const pickFolder = (current: string | null, prompt: string | null = null) => Dialogs.pickFolder(current, prompt);
