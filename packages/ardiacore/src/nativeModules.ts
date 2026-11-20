import { domainModule } from "./engine/call";
import type { CardInput } from "./autofill";
import type { SwipeModule } from "./swipe";

type Secret = Promise<string>;

export type ArdiaCoreNativeModules = {
  ArdiaTabs: {
    prepareTransfer(tabId: string): void;
    releaseTransfer(tabId: string): void;
    claimLaunchTab(tabId: string, url: string, profile: string): void;
    revealTab(tabId: string, press: number): void;
    dropTabReveals(overTabId: string, press: number, toTabId: string): void;
    claimTabPress(tabId: string, startedAt: number): number;
    dropTabPress(press: number): void;
    setTabsInSplits(tabIds: string[]): void;
    setNativeTabSwitch(enabled: boolean): void;
    revealOffered(adoptId: string, overTabId: string, press: number): void;
    discardOffered(adoptId: string): Promise<boolean>;
  };
  ArdiaEngine: { inputIdleSeconds(): number };
  ArdiaPasswords: {
    save(profile: string, origin: string, username: string, password: string): Secret;
    update(profile: string, origin: string, username: string, newUsername: string | null, newPassword: string | null): Secret;
  };
  ArdiaAutofill: { saveCard(profile: string, card: CardInput, number: string | null): Secret };
  ArdiaVaults: {
    signIn(provider: string, fieldsJSON: string): Secret;
    unlock(provider: string, passwordEntry: string | null, handOnTab: string | null, handOnOrigin: string | null): Secret;
  };
  ArdiaSwipe: SwipeModule;
};

const domainOfModule = (name: string) => `${name[5]!.toLowerCase()}${name.slice(6)}`;

export const nativeModule = <Name extends keyof ArdiaCoreNativeModules>(name: Name) =>
  domainModule<ArdiaCoreNativeModules[Name]>(domainOfModule(name));
