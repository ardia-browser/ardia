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

export type DialogsNative = {
  confirm(options: ConfirmOptions): Promise<{ confirmed: boolean; suppressed: boolean; unshown?: boolean; unavailable?: boolean }>;
  prompt(options: PromptOptions): Promise<string | null>;
  choose?(options: ChooseOptions): Promise<{ choice: number; unshown?: boolean }>;
  dismissesShownOnly?: boolean;
  dismissShownOnly?(key: string | null): Promise<void>;
  pickFiles(): Promise<string[]>;
  pickFolder(current: string | null, prompt: string | null): Promise<string | null>;
};
