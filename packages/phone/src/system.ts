import { requireOptionalNativeModule } from "expo-modules-core";
import type { Subscription } from "./pageTypes";

export type SystemLinkSource = "web" | "system" | "shortcut" | "share" | "handoff" | "intent";

export type SystemLink = (
  | { kind: "open"; url: string }
  | { kind: "search"; query: string | null }
  | { kind: "voiceSearch" }
  | { kind: "incognito" }
  | { kind: "tab"; id: string }
  | { kind: "macTabs" }
  | { kind: "inbox" }
) & { source: SystemLinkSource };

type NativeLink = Omit<SystemLink, "query"> & { query?: string };

type SystemNative = {
  labLog?: (line: string) => void;
  labFrameMark?: (label: string) => void;
  labSlice?: (label: string) => void;
  hardwareKeyboardShown?: () => boolean;
  addListener(eventName: "onSystemLink", listener: (link: NativeLink) => void): Subscription;
  initialLink(): Promise<NativeLink | null>;
  setHidesFromRecents?(hidden: boolean): Promise<boolean>;
  processStartedAt?(): number;
  launchBackdropShownAt?(): number | null;
  launchInterfaceDrawn?(): void;
  restoredValue?(key: string): string | null;
  setRestorableValue?(key: string, value: string | null): void;
  labMemory?(): string | null;
  labTrim?(): string | null;
  displayCornerRadius?(): number | null;
  setWidgetColorChoice?(choice: string | null): void;
  takePendingCounts?(): Record<string, number>;
  peekPendingCounts?(): Record<string, number>;
  takeExits?(): unknown[];
  syncOffered?(): boolean;
  setSystemBarIcons?(lightStatus: boolean, lightNavigation: boolean): Promise<void>;
  usageConsent?(): { sharing: boolean; generation: number } | null;
  setUsageConsent?(sharing: boolean): void;
};

const native = requireOptionalNativeModule<SystemNative>("ArdiaPhoneSystem");

const normalize = (link: NativeLink): SystemLink => (link.kind === "search" ? { ...link, query: link.query ?? null } : link) as SystemLink;

export const system = {
  initialLink: async (): Promise<SystemLink | null> => {
    const link = native ? await native.initialLink() : null;
    return link ? normalize(link) : null;
  },
  processStartedAt: (): number | null => (native?.processStartedAt ? native.processStartedAt() : null),
  launchBackdropShownAt: (): number | null => native?.launchBackdropShownAt?.() ?? null,
  launchInterfaceDrawn: (): void => native?.launchInterfaceDrawn?.(),
  displayCornerRadius: (): number | null => native?.displayCornerRadius?.() ?? null,
  setWidgetColorChoice: (choice: string | null): void => native?.setWidgetColorChoice?.(choice),
  takePendingCounts: (): Record<string, number> => native?.takePendingCounts?.() ?? {},
  peekPendingCounts: (): Record<string, number> => native?.peekPendingCounts?.() ?? {},
  takeExits: (): unknown[] => {
    try {
      return native?.takeExits?.() ?? [];
    } catch {
      return [];
    }
  },
  syncOffered: (): boolean | null => native?.syncOffered?.() ?? null,
  setsSystemBarIcons: (): boolean => typeof native?.setSystemBarIcons === "function",
  setSystemBarIcons: (lightStatus: boolean, lightNavigation: boolean): void => void native?.setSystemBarIcons?.(lightStatus, lightNavigation)?.catch(() => undefined),
  usageConsent: (): { sharing: boolean; generation: number } | null => native?.usageConsent?.() ?? null,
  setUsageConsent: (sharing: boolean): void => native?.setUsageConsent?.(sharing),
  setHidesFromRecents: async (hidden: boolean): Promise<boolean> => (native?.setHidesFromRecents ? native.setHidesFromRecents(hidden) : false),
  addLinkListener: (listener: (link: SystemLink) => void): Subscription =>
    native ? native.addListener("onSystemLink", (link) => listener(normalize(link))) : { remove() {} },
};

const remembered = new Map<string, string>();

export const restorableState = {
  get: (key: string): string | null => native?.restoredValue?.(key) ?? remembered.get(key) ?? null,
  set: (key: string, value: string | null) => {
    if (value === null) remembered.delete(key);
    else remembered.set(key, value);
    native?.setRestorableValue?.(key, value);
  },
};

export function labSlice(label: string) {
  native?.labSlice?.(label);
}

export const hardwareKeyboardShown = () => native?.hardwareKeyboardShown?.() ?? false;

export function labFrameMark(label: string) {
  native?.labFrameMark?.(label);
}

export function labLog(line: string) {
  if (native?.labLog) native.labLog(line);
  else console.log(line);
}

export const systemLab = {
  memory: (): string | null => native?.labMemory?.() ?? null,
  trim: (): string | null => native?.labTrim?.() ?? null,
};
