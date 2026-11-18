let counts = { page_focus_returns_after_bar: 0 };

export const notePageFocusReturnAfterBar = () => void counts.page_focus_returns_after_bar++;

export function takePageFocusReturns() {
  const taken = counts;
  counts = { page_focus_returns_after_bar: 0 };
  return taken;
}
