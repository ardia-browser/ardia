import type { DialogsNative } from "./generated/native";

export type ConfirmOptions = {
  title: string;
  message?: string;
  confirmTitle?: string;
  cancelTitle?: string;
  destructive?: boolean;
  suppression?: string;
  windowId?: string;
  onlyIfShown?: boolean;
  dismissKey?: string;
  sheetOnly?: boolean;
};

export type ChooseOptions = {
  title: string;
  message?: string;
  choices: string[];
  cancelChoice?: number;
  noDefault?: boolean;
  windowId?: string;
  onlyIfShown?: boolean;
  dismissKey?: string;
};

export type PromptOptions = {
  title: string;
  message?: string;
  value?: string;
  placeholder?: string;
  confirmTitle?: string;
  windowId?: string;
};

export type { DialogsNative };
