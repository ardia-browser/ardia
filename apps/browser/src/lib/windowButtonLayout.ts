export type WindowButton = "menu" | "minimize" | "maximize" | "close";

export type WindowButtonLayout = { leading: readonly WindowButton[]; trailing: readonly WindowButton[] };

export type WindowButtonSide = "right" | "left" | "both" | "none";

export const WINDOW_CONTROLS = { edge: 12, gap: 3, button: 30, regular: 30, small: 28, band: 26, strip: 18 } as const;

export const windowControlsWidth = (count = 3) => (count > 0 ? count * WINDOW_CONTROLS.button + (count - 1) * WINDOW_CONTROLS.gap : 0);

export const TRAFFIC_LIGHTS_WIDTH = 78;

export const DESKTOP_BUTTON_LAYOUT_FALLBACK = ":minimize,maximize,close";

const BUTTON_OF = new Map<string, WindowButton>([["minimize", "minimize"], ["maximize", "maximize"], ["close", "close"]]);

export function parseButtonLayout(raw: string | null | undefined): WindowButtonLayout {
  const source = typeof raw === "string" ? raw : DESKTOP_BUTTON_LAYOUT_FALLBACK;
  const colon = source.indexOf(":");
  const placed = new Set<WindowButton>();
  const buttonsOf = (side: string) =>
    side.split(",").flatMap((token): WindowButton[] => {
      const button = BUTTON_OF.get(token);
      if (!button || placed.has(button)) return [];
      placed.add(button);
      return [button];
    });
  const leading = buttonsOf(colon < 0 ? source : source.slice(0, colon));
  const trailing = buttonsOf(colon < 0 ? "" : source.slice(colon + 1));
  return { leading, trailing: ["menu", ...trailing] };
}

export const BROWSER_BUTTON_LAYOUT: WindowButtonLayout = parseButtonLayout(DESKTOP_BUTTON_LAYOUT_FALLBACK);

export type WindowButtonsAllowed = { menu?: boolean; minimizable?: boolean; maximizable?: boolean };

export const windowButtonsFor = (buttons: readonly WindowButton[], { menu = true, minimizable = true, maximizable = true }: WindowButtonsAllowed): WindowButton[] =>
  buttons.filter((button) => (button === "menu" ? menu : button === "minimize" ? minimizable : button === "maximize" ? maximizable : true));

const windowButtonCount = (buttons: readonly WindowButton[]) => buttons.filter((button) => button !== "menu").length;

export function buttonLayoutSide(layout: WindowButtonLayout): WindowButtonSide {
  const left = windowButtonCount(layout.leading) > 0;
  const right = windowButtonCount(layout.trailing) > 0;
  return left && right ? "both" : left ? "left" : right ? "right" : "none";
}

export const buttonLayoutCount = (layout: WindowButtonLayout): number => windowButtonCount(layout.leading) + windowButtonCount(layout.trailing);
