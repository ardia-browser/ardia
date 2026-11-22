let edited = 0;
let reset = 0;

export function noteThemePreset(event: "edited" | "reset") {
  if (event === "edited") edited++;
  else reset++;
}

export function takeThemePresetCounts() {
  const taken = { theme_presets_edited: edited, theme_presets_reset: reset };
  edited = 0;
  reset = 0;
  return taken;
}
