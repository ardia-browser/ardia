import { reportHostError } from "./host.ts";

type Anchor = { closest(selector: string): Element | null };
type ActivationTarget = {
  addEventListener(type: "pointerdown", listener: (event: { button: number; target: EventTarget | null }) => void, capture: boolean): void;
  addEventListener(type: "keydown", listener: (event: { key: string }) => void, capture: boolean): void;
};

export const CLUSTER_MENU_BUTTON = '[role="button"][aria-label="Menu"]';

type ClusterMenuHooks = {
  target: ActivationTarget | null;
  open(windowId: string, anchor: HTMLElement): Promise<unknown>;
  shown(): boolean;
  dismiss(): void;
  focused(): Element | null;
  visible(): Element | null;
};

const menuButtonOf = (element: unknown): Element | null =>
  element && typeof element === "object" && "closest" in element ? (element as Anchor).closest(CLUSTER_MENU_BUTTON) : null;

export function createClusterMenu({ target, open, shown, dismiss, focused, visible }: ClusterMenuHooks) {
  let pressed: Element | null = null;
  let openAtPress = false;
  target?.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) {
      pressed = null;
      openAtPress = false;
      return;
    }
    pressed = menuButtonOf(event.target);
    openAtPress = !!pressed && shown();
  }, true);
  target?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    pressed = null;
    openAtPress = false;
  }, true);
  return (windowId: string) => {
    const wasOpen = openAtPress || shown();
    const anchor = (pressed?.isConnected ? pressed : null) ?? menuButtonOf(focused()) ?? visible();
    pressed = null;
    openAtPress = false;
    if (wasOpen) {
      dismiss();
      return Promise.resolve();
    }
    if (!anchor) return Promise.resolve();
    return open(windowId, anchor as HTMLElement).catch(reportHostError);
  };
}

type Visibility = Element & { checkVisibility?(options: { checkOpacity: boolean; checkVisibilityCSS: boolean }): boolean };

export const visibleClusterMenuButton = (root: Pick<Document, "querySelectorAll">): Element | null =>
  [...root.querySelectorAll<Visibility>(CLUSTER_MENU_BUTTON)].find((button) => {
    const box = button.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && (button.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) ?? true);
  }) ?? null;
