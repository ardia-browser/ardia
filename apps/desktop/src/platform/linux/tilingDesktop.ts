const TILING_DESKTOPS: readonly string[] = ["hyprland", "sway", "niri", "i3", "river", "dwl", "bspwm", "awesome", "qtile", "xmonad", "dwm", "herbstluftwm", "regolith"];

export const isTilingDesktop = (desktop: string | null | undefined): boolean =>
  typeof desktop === "string" && desktop.split(":").some((name) => TILING_DESKTOPS.includes(name.trim().toLowerCase()));
