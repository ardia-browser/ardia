import { curve, duration } from "../ui/motion";
import { radius, type ColorRoles } from "../ui/tokens";
import { over } from "../../lib/color";

const DARK = {
  emptyStateFill: "rgba(34,32,33,0.92)",
};

const LIGHT: typeof DARK = {
  emptyStateFill: "rgba(255,255,255,0.92)",
};

type SplitColors = typeof DARK;

export const splitColors = (dark: boolean): SplitColors => (dark ? DARK : LIGHT);

export const emptyPaneFieldSurface = (roles: ColorRoles) => over(roles.rowHover, splitColors(roles.dark).emptyStateFill);

export const emptyStateRadius = () => radius.sheet;
export const EMPTY_STATE_WIDTH = 420;
export const SPLIT_ROW_HEIGHT = 36;
export const splitRowRadius = () => radius.chrome;
export const dropPreviewRadius = () => radius.hero;
export const DROP_PREVIEW = {
  fill: "rgba(18,20,28,0.58)",
  border: "rgba(255,255,255,0.85)",
  borderWidth: 1.5,
  label: "#FFFFFF",
  shadow: { color: "#000000", opacity: 0.3, radius: 12, offset: [0, 2] as [number, number] },
} as const;

export const FOCUS_RING = { width: 2, gap: 1 } as const;

export const SPLIT_MOTION = {
  dropPreview: { show: { duration: duration.fast, easing: curve.enter }, hide: { duration: duration.fast, easing: curve.exit } },
} as const;

export const TOAST_MS = 2600;
export const TOAST_ACTION_MS = 4000;
