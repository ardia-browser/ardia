const NO_COUNTS = { downloads_panel_press_closes: 0, downloads_panel_held_opens: 0 };
let counts = { ...NO_COUNTS };

const KEYS = { pressClose: "downloads_panel_press_closes", heldOpen: "downloads_panel_held_opens" } as const;

export const noteDownloadsPanel = (event: keyof typeof KEYS) => void counts[KEYS[event]]++;

export function takeDownloadsPanelCounts() {
  const taken = counts;
  counts = { ...NO_COUNTS };
  return taken;
}
