let counts = { chrome_settings_opens: 0 };

export const noteChromeSettingsOpen = () => void counts.chrome_settings_opens++;

export function takeChromeSettingsOpens() {
  const taken = counts;
  counts = { chrome_settings_opens: 0 };
  return taken;
}
