const counts = { askedAfterCloseTabs: 0, cancelledAfterCloseTabs: 0 };

export function noteQuitWarningAfterCloseTabs(answer: "confirmed" | "cancelled") {
  counts.askedAfterCloseTabs += 1;
  if (answer === "cancelled") counts.cancelledAfterCloseTabs += 1;
}

export function takeQuitWarningCounts() {
  const taken = { quit_warnings_after_close_tabs: counts.askedAfterCloseTabs, quit_warnings_after_close_tabs_cancelled: counts.cancelledAfterCloseTabs };
  counts.askedAfterCloseTabs = 0;
  counts.cancelledAfterCloseTabs = 0;
  return taken;
}
