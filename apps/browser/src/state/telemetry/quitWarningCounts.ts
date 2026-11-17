let asked = 0;
let cancelled = 0;

export function noteQuitAskedAfterTabsConfirm(wasCancelled: boolean) {
  asked++;
  if (wasCancelled) cancelled++;
}

export function takeQuitWarningCounts() {
  const taken = { quit_warnings_after_tabs_confirm: asked, quit_warnings_after_tabs_confirm_cancelled: cancelled };
  asked = cancelled = 0;
  return taken;
}
