import { requireNativeView } from "expo";
import { requireOptionalNativeModule } from "expo-modules-core";
import { createElement, type ComponentType } from "react";
import type { Subscription } from "./pageTypes";

export type BrowseForMeOutcome = "chatgpt" | "on_device" | "excerpts" | "failed";

export type ChatGPTModelChoice = { slug: string; name: string; efforts: string[]; defaultEffort: string | null };

export type ChatGPTAccountState = {
  connected: boolean;
  label: string | null;
  signingIn: boolean;
  problem: string | null;
  model: string | null;
  effort: string | null;
  models: ChatGPTModelChoice[];
};

export type BrowseForMeEvent =
  | { name: "openSource"; url: string }
  | { name: "searchWeb"; query: string }
  | { name: "openLink"; url: string }
  | { name: "closed" }
  | { name: "settled"; outcome: BrowseForMeOutcome; chatGPTFellBack: boolean }
  | { name: "talkToMe"; count: string }
  | { name: "account"; connected: boolean; account?: ChatGPTAccountState };

type BrowseForMeNative = {
  isConnected(): Promise<boolean>;
  open(query: string): Promise<void>;
  account?(): Promise<ChatGPTAccountState>;
  connect?(): Promise<boolean>;
  disconnect?(): Promise<void>;
  chooseModel?(slug: string): Promise<void>;
  chooseEffort?(effort: string | null): Promise<void>;
  clearProblem?(): Promise<void>;
  openUsage?(): Promise<void>;
  addListener(eventName: "onBrowseForMe", listener: (event: BrowseForMeEvent) => void): Subscription;
};

export const BROWSE_FOR_ME_MODULE = "ArdiaPhoneBrowseForMe";

const native = () => requireOptionalNativeModule<BrowseForMeNative>(BROWSE_FOR_ME_MODULE);

export const browseForMe = {
  available: (): boolean => native() !== null,
  isConnected: async (): Promise<boolean> => (await native()?.isConnected()) ?? false,
  open: async (query: string): Promise<void> => {
    await native()?.open(query);
  },
  managesAccountInJS: (): boolean => typeof native()?.account === "function",
  account: async (): Promise<ChatGPTAccountState | null> => (await native()?.account?.()) ?? null,
  connect: async (): Promise<boolean> => (await native()?.connect?.()) ?? false,
  disconnect: async (): Promise<void> => {
    await native()?.disconnect?.();
  },
  chooseModel: async (slug: string): Promise<void> => {
    await native()?.chooseModel?.(slug);
  },
  chooseEffort: async (effort: string | null): Promise<void> => {
    await native()?.chooseEffort?.(effort);
  },
  clearProblem: async (): Promise<void> => {
    await native()?.clearProblem?.();
  },
  openUsage: async (): Promise<void> => {
    await native()?.openUsage?.();
  },
  addListener: (listener: (event: BrowseForMeEvent) => void): Subscription => native()?.addListener("onBrowseForMe", listener) ?? { remove() {} },
};

let settingsView: ComponentType<{ testID?: string }> | undefined;

export function BrowseForMeSettings({ testID }: { testID?: string }) {
  if (!browseForMe.available()) return null;
  settingsView ??= requireNativeView<{ testID?: string }>(BROWSE_FOR_ME_MODULE, "BrowseForMeSettingsView");
  return createElement(settingsView, { testID });
}
