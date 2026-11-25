import { nativeModule, type ChooseOptions, type ConfirmOptions, type PromptOptions } from "@ardia/shell";

export type { ChooseOptions };

const Dialogs = nativeModule("ArdiaDialogs");

export const confirm = (options: ConfirmOptions) => Dialogs.confirm(options);
export const canDismissShownOnlyDialogs = () => Dialogs.dismissesShownOnly === true;
export const dismissShownOnlyDialogs = async (key?: string) => {
  await Dialogs.dismissShownOnly?.(key ?? null);
};
export const choose = async (options: ChooseOptions) => (Dialogs.choose ? Dialogs.choose(options) : { choice: -1, unshown: true });
export const prompt = (options: PromptOptions) => Dialogs.prompt(options);
export const pickFiles = () => Dialogs.pickFiles();
export const pickFolder = (current: string | null, prompt: string | null = null) => Dialogs.pickFolder(current, prompt);
