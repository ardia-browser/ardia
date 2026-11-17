export type WindowChrome = {
  leadingWidth: number;
  trailingWidth: number;
  titleBarHeight: number;
  pageCornerRadius: number | null;
};

export const WINDOW_CHROME: WindowChrome = { leadingWidth: 78, trailingWidth: 0, titleBarHeight: 0, pageCornerRadius: null };
