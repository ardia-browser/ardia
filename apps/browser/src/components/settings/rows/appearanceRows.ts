import { type SettingsEnv, type SettingSection } from "./types";
import type { SettingsPane } from "../../../state/settings/settingsWindows";
import { keyText } from "../../../state/commands/keyText";
import { PLATFORM_FEATURES } from "../../../lib/platformFeatures";
import { PLATFORM_TERMS } from "../../../lib/platformTerms";
import { interfaceScaleAdjustable } from "../../../state/settings/interfaceScale";
import { windowButtonsChoosable } from "../../../lib/windowChrome";
import { t } from "../../../lib/uiLanguage";


const inSidebar = (_: unknown, env: SettingsEnv) => !env.top;

export const appearanceRows = {
  appearance: [
    {
      section: t(`Look`),
      rows: {
        theme: {
          title: t(`Theme`),
          description: t(`Incognito windows are always dark.`),
          keywords: ["appearance", t(`dark mode`), t(`light mode`), "dark", "light", "automatic", "night", "system"],
        },
        interfaceStyle: {
          title: t(`Interface style`),
          description: t(`Glass uses Liquid Glass. Classic is flat, like Dia.`),
          keywords: [t(`liquid glass`), "glass", "classic", "flat", "translucent", "transparency", "glow", "frosted"],
          shown: (_, env) => !!env.glass,
        },
        glassTint: {
          title: t(`Glass tint`),
          description: t(`How much the profile color tints the glass.`),
          keywords: [t(`liquid glass`), "tint", "strength", "intensity", "colour", "color", "glossy", t(`tint amount`), t(`profile colour`), "theme", t(`tint glass with the profile colour`)],
          shown: (s, env) => !!env.glass && s.interfaceStyle === "glass",
          needs: t(`Choose the Glass style to use this`),
        },
        elementOutlines: {
          title: t(`Outlines around tiles and fields`),
          explained: true,
          description: t(`Off is flatter, like Arc.`),
          keywords: ["outline", "outlines", "border", "borders", "edge", "stroke", "ring", "flat", "arc", t(`pinned tiles`), t(`top apps`), t(`address field`), "clean"],
        },
        extendWebsiteColor: {
          title: t(`Extend website color into tab bar`),
          keywords: [t(`theme color`), "tint", "colour"],
        },
        selectedTabGlow: {
          title: t(`Glow around the selected tab`),
          description: t(`Full is Dia's.`),
          keywords: ["glow", "shadow", "halo", "highlight", t(`selected tab`), t(`active tab`)],
        },
        selectedTopApp: {
          title: t(`Selected Top App`),
          description: t(`How the selected pinned tile looks.`),
          keywords: ["ring", "outline", "outlined", "border", "fill", "filled", t(`top apps`), t(`pinned tile`), t(`pinned tab`), t(`selected tile`), t(`active tile`), t(`white ring`), "classic"],
          shown: (s) => s.elementOutlines,
        },
        appIcon: {
          title: t(`App Icon`),
          description: t(`Shown in the Dock and the app switcher.`),
          keywords: [t(`dock icon`), "logo"],
          shown: () => PLATFORM_FEATURES.appIcon,
        },
      },
    },
    {
      section: t(`Window buttons`),
      rows: {
        windowButtons: {
          title: t(`Window buttons`),
          description: t(`Native follows your desktop's button layout, and on tiling desktops such as Hyprland or sway draws no window buttons. Traffic lights put close, minimize and maximize at the top left, as on a Mac. Full screen hides both. Hidden draws none on any desktop and keeps no room for them; the menu button stays in the header.`),
          keywords: [t(`window controls`), t(`title bar`), "titlebar", t(`close button`), "minimize", "maximize", t(`traffic lights`), "gnome", "kde", "native", "decorations", "linux", "hidden", "none", "tiling", "i3", "sway", "hyprland"],
          shown: () => windowButtonsChoosable,
        },
      },
    },
    {
      section: t(`Size and text`),
      rows: {
        interfaceScale: {
          title: t(`Interface size`),
          explained: true,
          description: t(`Resizes Ardia, not web pages.`),
          keywords: ["scale", "scaling", t(`ui scale`), t(`ui size`), t(`interface scale`), "zoom", t(`zoom interface`), t(`fractional scaling`), t(`1440p`), t(`4k`), t(`high resolution`), "retina", "bigger", "smaller", "larger", "display", "monitor", "density", "accessibility", t(`low vision`)],
          shown: () => PLATFORM_FEATURES.interfaceSize && interfaceScaleAdjustable(),
        },
        sidebarTextSize: {
          title: t(`Sidebar text size`),
          description: t(`Titles and icons in the sidebar.`),
          keywords: [t(`bigger text`), t(`larger text`), t(`large text`), t(`text size`), t(`small text`), "readability", "readable", t(`low vision`), "accessibility", "a11y", t(`tab titles`), "arc"],
          shown: inSidebar,
          needs: t(`Use vertical tabs to change this`),
        },
        sidebarTextContrast: {
          title: t(`Higher contrast text`),
          description: t(`Stronger text and icons in the sidebar.`),
          keywords: ["contrast", t(`high contrast`), t(`increase contrast`), t(`grey text`), t(`gray text`), t(`light text`), "faint", "readability", "readable", t(`low vision`), "accessibility", "a11y", "wcag", "bold"],
          shown: inSidebar,
          needs: t(`Use vertical tabs to change this`),
        },
      },
    },
    {
      section: t(`Switching tabs`),
      rows: {
        ctrlTab: {
          title: `What ${PLATFORM_TERMS.switchTabsKey} does`,
          description: t(`Step through your tabs in order, or open the recent tabs switcher.`),
          keywords: [t(`ctrl tab`), t(`control tab`), t(`alt tab`), t(`tab switcher`), t(`switch tabs`), t(`switching tabs`), t(`recent tabs`), t(`recently used`), t(`last tab`), t(`previous tab`), t(`next tab`), t(`cycle tabs`), "mru", "tabbing", "arc", "dia", "chrome"],
        },
      },
    },
    {
      section: t(`Toolbar`),
      rows: {
        addressBar: {
          title: t(`Address bar`),
          description: t(`In the toolbar or in the sidebar.`),
          keywords: [t(`url bar`), t(`location bar`), "toolbar", t(`address bar`), t(`address field`), "omnibox", t(`url field`), t(`address bar in sidebar`), "arc", "dia"],
          shown: inSidebar,
          needs: t(`Use vertical tabs to change this`),
        },
        compactToolbar: {
          title: t(`Compact toolbar`),
          explained: true,
          description: t(`A shorter toolbar, so pages get more room.`),
          keywords: [t(`toolbar height`), t(`smaller toolbar`), t(`thin toolbar`), "slim", "dense", "helium", "video", "16:9", t(`black bars`), t(`url bar`)],
          shown: (s, env) => env.top || s.addressBar === "toolbar",
          needs: t(`Put the address bar in the toolbar to use this`),
        },
        commandBarPlacement: {
          title: `${keyText("⌘L")} opens the command bar`,
          explained: true,
          description: t(`Shows the address over the middle of the page, like Arc.`),
          keywords: [t(`cmd l`), t(`command l`), t(`ctrl l`), t(`command bar`), t(`command palette`), "centred", "centered", "middle", "floating", "arc", t(`url bar`), t(`location bar`), "click", t(`click address`), t(`click url`)],
        },
        commandBarOnClick: {
          title: t(`Clicking the address opens it in the center too`),
          keywords: [t(`click address`), t(`click url`), t(`centred on click`), t(`command bar on click`)],
          shown: (s) => s.commandBarPlacement !== "field",
          needs: `Choose In the center for ${keyText("⌘L")} to use this`,
        },
        addressBarButtons: {
          title: t(`Address bar buttons`),
          explained: true,
          description: t(`Show on hover hides them until you point at the address bar.`),
          keywords: ["hover", t(`always show`), t(`always visible`), t(`site controls`), t(`split view`), "bookmark", t(`copy url`), "buttons", "icons", "extensions", t(`pinned extensions`), "clean", "arc", t(`url bar`), t(`location bar`)],
        },
        minimalismMode: {
          title: t(`Minimalism mode`),
          explained: true,
          description: `Just tabs and the page, no toolbar. ${keyText("⌃⌘M")} toggles it.`,
          keywords: ["minimal", "minimalism", "minimalist", "clean", "compact", "zen", "simple", t(`distraction free`), t(`no toolbar`), t(`hide toolbar`), t(`search browser`), "quiet", "focus"],
        },
        bookmarksBar: {
          title: t(`Bookmarks bar`),
          description: `Below the toolbar. ${keyText("⇧⌘B")} toggles it.`,
          keywords: [t(`bookmarks bar`), t(`favorites bar`), t(`favourites bar`), "toolbar", t(`hide bookmarks`), t(`show bookmarks`), t(`show bookmarks bar`), t(`bookmark button`), "star", t(`bookmarks menu`), t(`copy url`), "arc", t(`no bookmarks`)],
        },
      },
    },
    {
      section: t(`Page frame`),
      rows: {
        pageFrame: {
          title: t(`Frame around the page`),
          description: t(`0 is borderless.`),
          keywords: ["border", "borderless", t(`edge to edge`), "margin", "inset", "padding", t(`rounded corners`), t(`corner radius`), "frame", "gap", t(`full bleed`), "arc", "compact", t(`no borders`), "frameless", t(`borderless mode`)],
        },
        fullScreenFrame: {
          title: t(`In full screen`),
          description: t(`Keep the frame, or remove it.`),
          keywords: ["fullscreen", t(`full screen`), "borderless", t(`edge to edge`), "zero", "none", "frame", "inset", "margin", t(`zero in full screen`), t(`auto hide`), "autohide", "sidebar", t(`tabs hidden`), t(`zero in full screen when tabs are hidden`)],
          shown: (s) => !s.borderlessMode,
          needs: t(`Set Frame around the page above 0`),
        },
        tabCornerRadius: {
          title: t(`Tab corners`),
          description: t(`How round tab corners are. 10 pt is Dia's.`),
          keywords: ["corner", "corners", "radius", "rounded", "round", "square", t(`tab shape`), t(`tab corners`), t(`rounded tabs`), "pill"],
        },
      },
    },
  ],
} satisfies Pick<Record<SettingsPane, SettingSection[]>, "appearance">;
