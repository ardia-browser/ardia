import { AccessibilityInfo as WebAccessibilityInfo } from "react-native-web";

type ContrastQuery = {
  matches: boolean;
  addEventListener(type: "change", listener: (event: { matches: boolean }) => void): void;
  removeEventListener(type: "change", listener: (event: { matches: boolean }) => void): void;
};
type Subscription = { remove(): void };
type Listener = (value: boolean) => void;

export const HIGH_CONTRAST_QUERY = "(prefers-contrast: more), (forced-colors: active)";

const systemContrastQuery = (): ContrastQuery | null =>
  typeof matchMedia === "function" ? (matchMedia(HIGH_CONTRAST_QUERY) as unknown as ContrastQuery) : null;

export function createAccessibilityInfo(contrast: () => ContrastQuery | null = systemContrastQuery) {
  let query: ContrastQuery | null | undefined;
  const contrastQuery = () => (query === undefined ? (query = contrast()) : query);
  const watchContrast = (handler: Listener): Subscription => {
    const watched = contrastQuery();
    if (!watched) return { remove() {} };
    const listener = (event: { matches: boolean }) => handler(event.matches);
    watched.addEventListener("change", listener);
    return { remove: () => watched.removeEventListener("change", listener) };
  };
  return {
    ...WebAccessibilityInfo,
    isHighContrastEnabled: (): Promise<boolean> => Promise.resolve(contrastQuery()?.matches ?? false),
    addEventListener(event: string, handler: Listener): Subscription {
      if (event === "highContrastChanged") return watchContrast(handler);
      return (WebAccessibilityInfo.addEventListener as (event: string, handler: Listener) => Subscription | undefined)(event, handler) ?? { remove() {} };
    },
  };
}

export const AccessibilityInfo = createAccessibilityInfo() as unknown as typeof WebAccessibilityInfo;
