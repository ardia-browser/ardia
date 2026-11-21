import { type SettingsEnv, type SettingSection } from "./types";
import type { SettingsPane } from "../../../state/settings/settingsWindows";
import { keyText } from "../../../state/commands/keyText";
import { PLATFORM_FEATURES } from "../../../lib/platformFeatures";
import { PLATFORM_TERMS } from "../../../lib/platformTerms";
import { interfaceScaleAdjustable } from "../../../state/settings/interfaceScale";
import { windowButtonsChoosable } from "../../../lib/windowChrome";

const inSidebar = (_: unknown, env: SettingsEnv) => !env.top;

export const appearanceRows = {
  appearance: [
    {
      section: "Look",
      rows: {
        theme: {
          title: "Theme",
          description: "Incognito windows are always dark.",
          keywords: ["appearance", "dark mode", "light mode", "dark", "light", "automatic", "night", "system"],
        },
        interfaceStyle: {
          title: "Interface style",
          description: "Glass uses Liquid Glass. Classic is flat, like Dia.",
          keywords: ["liquid glass", "glass", "classic", "flat", "translucent", "transparency", "glow", "frosted"],
          shown: (_, env) => !!env.glass,
        },
        glassTint: {
          title: "Glass tint",
          description: "How much the profile color tints the glass.",
          keywords: ["liquid glass", "tint", "strength", "intensity", "colour", "color", "glossy", "tint amount", "profile colour", "theme", "tint glass with the profile colour"],
          shown: (s, env) => !!env.glass && s.interfaceStyle === "glass",
          needs: "Choose the Glass style to use this",
        },
        elementOutlines: {
          title: "Outlines around tiles and fields",
          explained: true,
          description: "Off is flatter, like Arc.",
          keywords: ["outline", "outlines", "border", "borders", "edge", "stroke", "ring", "flat", "arc", "pinned tiles", "top apps", "address field", "clean"],
        },
        extendWebsiteColor: {
          title: "Extend website color into tab bar",
          keywords: ["theme color", "tint", "colour"],
        },
        selectedTabGlow: {
          title: "Glow around the selected tab",
          description: "Full is Dia's.",
          keywords: ["glow", "shadow", "halo", "highlight", "selected tab", "active tab"],
        },
        selectedTopApp: {
          title: "Selected Top App",
          description: "How the selected pinned tile looks.",
          keywords: ["ring", "outline", "outlined", "border", "fill", "filled", "top apps", "pinned tile", "pinned tab", "selected tile", "active tile", "white ring", "classic"],
          shown: (s) => s.elementOutlines,
        },
        appIcon: {
          title: "App Icon",
          description: "Shown in the Dock and the app switcher.",
          keywords: ["dock icon", "logo"],
          shown: () => PLATFORM_FEATURES.appIcon,
        },
      },
    },
    {
      section: "Window buttons",
      rows: {
        windowButtons: {
          title: "Window buttons",
          description: "Native puts minimize, maximize and close at the top right. Traffic lights put close, minimize and maximize at the top left, as on a Mac. Full screen hides both. Hidden draws none and keeps no room for them, for tiling window managers; the menu button stays in the header.",
          keywords: ["window controls", "title bar", "titlebar", "close button", "minimize", "maximize", "traffic lights", "gnome", "kde", "native", "decorations", "linux", "hidden", "none", "tiling", "i3", "sway", "hyprland"],
          shown: () => windowButtonsChoosable,
        },
      },
    },
    {
      section: "Size and text",
      rows: {
        interfaceScale: {
          title: "Interface size",
          explained: true,
          description: "Resizes Ardia, not web pages.",
          keywords: ["scale", "scaling", "ui scale", "ui size", "interface scale", "zoom", "zoom interface", "fractional scaling", "1440p", "4k", "high resolution", "retina", "bigger", "smaller", "larger", "display", "monitor", "density", "accessibility", "low vision"],
          shown: () => PLATFORM_FEATURES.interfaceSize && interfaceScaleAdjustable(),
        },
        sidebarTextSize: {
          title: "Sidebar text size",
          description: "Titles and icons in the sidebar.",
          keywords: ["bigger text", "larger text", "large text", "text size", "small text", "readability", "readable", "low vision", "accessibility", "a11y", "tab titles", "arc"],
          shown: inSidebar,
          needs: "Use vertical tabs to change this",
        },
        sidebarTextContrast: {
          title: "Higher contrast text",
          description: "Stronger text and icons in the sidebar.",
          keywords: ["contrast", "high contrast", "increase contrast", "grey text", "gray text", "light text", "faint", "readability", "readable", "low vision", "accessibility", "a11y", "wcag", "bold"],
          shown: inSidebar,
          needs: "Use vertical tabs to change this",
        },
      },
    },
    {
      section: "Switching tabs",
      rows: {
        ctrlTab: {
          title: `What ${PLATFORM_TERMS.switchTabsKey} does`,
          description: "Step through your tabs in order, or open the recent tabs switcher.",
          keywords: ["ctrl tab", "control tab", "alt tab", "tab switcher", "switch tabs", "switching tabs", "recent tabs", "recently used", "last tab", "previous tab", "next tab", "cycle tabs", "mru", "tabbing", "arc", "dia", "chrome"],
        },
      },
    },
    {
      section: "Toolbar",
      rows: {
        addressBar: {
          title: "Address bar",
          description: "In the toolbar or in the sidebar.",
          keywords: ["url bar", "location bar", "toolbar", "address bar", "address field", "omnibox", "url field", "address bar in sidebar", "arc", "dia"],
          shown: inSidebar,
          needs: "Use vertical tabs to change this",
        },
        compactToolbar: {
          title: "Compact toolbar",
          explained: true,
          description: "A shorter toolbar, so pages get more room.",
          keywords: ["toolbar height", "smaller toolbar", "thin toolbar", "slim", "dense", "helium", "video", "16:9", "black bars", "url bar"],
          shown: (s, env) => env.top || s.addressBar === "toolbar",
          needs: "Put the address bar in the toolbar to use this",
        },
        commandBarPlacement: {
          title: `${keyText("⌘L")} opens the command bar`,
          explained: true,
          description: "Shows the address over the middle of the page, like Arc.",
          keywords: ["cmd l", "command l", "ctrl l", "command bar", "command palette", "centred", "centered", "middle", "floating", "arc", "url bar", "location bar", "click", "click address", "click url"],
        },
        commandBarOnClick: {
          title: "Clicking the address opens it in the center too",
          keywords: ["click address", "click url", "centred on click", "command bar on click"],
          shown: (s) => s.commandBarPlacement !== "field",
          needs: `Choose In the center for ${keyText("⌘L")} to use this`,
        },
        addressBarButtons: {
          title: "Address bar buttons",
          explained: true,
          description: "Show on hover hides them until you point at the address bar.",
          keywords: ["hover", "always show", "always visible", "site controls", "split view", "bookmark", "copy url", "buttons", "icons", "extensions", "pinned extensions", "clean", "arc", "url bar", "location bar"],
        },
        minimalismMode: {
          title: "Minimalism mode",
          explained: true,
          description: `Just tabs and the page, no toolbar. ${keyText("⌃⌘M")} toggles it.`,
          keywords: ["minimal", "minimalism", "minimalist", "clean", "compact", "zen", "simple", "distraction free", "no toolbar", "hide toolbar", "search browser", "quiet", "focus"],
        },
        bookmarksBar: {
          title: "Bookmarks bar",
          description: `Below the toolbar. ${keyText("⇧⌘B")} toggles it.`,
          keywords: ["bookmarks bar", "favorites bar", "favourites bar", "toolbar", "hide bookmarks", "show bookmarks", "show bookmarks bar", "bookmark button", "star", "bookmarks menu", "copy url", "arc", "no bookmarks"],
        },
      },
    },
    {
      section: "Page frame",
      rows: {
        pageFrame: {
          title: "Frame around the page",
          description: "0 is borderless.",
          keywords: ["border", "borderless", "edge to edge", "margin", "inset", "padding", "rounded corners", "corner radius", "frame", "gap", "full bleed", "arc", "compact", "no borders", "frameless", "borderless mode"],
        },
        fullScreenFrame: {
          title: "In full screen",
          description: "Keep the frame, or remove it.",
          keywords: ["fullscreen", "full screen", "borderless", "edge to edge", "zero", "none", "frame", "inset", "margin", "zero in full screen", "auto hide", "autohide", "sidebar", "tabs hidden", "zero in full screen when tabs are hidden"],
          shown: (s) => !s.borderlessMode,
          needs: "Set Frame around the page above 0",
        },
        tabCornerRadius: {
          title: "Tab corners",
          description: "How round tab corners are. 10 pt is Dia's.",
          keywords: ["corner", "corners", "radius", "rounded", "round", "square", "tab shape", "tab corners", "rounded tabs", "pill"],
        },
      },
    },
  ],
} satisfies Pick<Record<SettingsPane, SettingSection[]>, "appearance">;
