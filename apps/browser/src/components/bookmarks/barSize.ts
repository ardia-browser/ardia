import { barSizes, type BarSize } from "./tokens";

export const useBarSize = (): BarSize => barSizes.default;

export const useBookmarksBarHeight = (): number => useBarSize().height;
