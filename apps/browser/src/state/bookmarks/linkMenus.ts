import { cleanUrl, linkLines, markdownLink } from "@ardia/core";
import { copyLink } from "../../platform/clipboard";
import type { MenuItem } from "../../platform/menus";
import { withOptionAlternate, type MenuEntry } from "../app/menuSections";
import { openLinks, openUrl, type OpenAllMode } from "./actions";
import { splitViewAvailable } from "../splits/splits";
import { t } from "../../lib/i18n";

export type Link = { url: string; title?: string | null };

const OPEN_SYMBOLS = { tab: "plus.app", window: "macwindow.badge.plus", incognito: "eyeglasses", split: "rectangle.split.2x1" } as const;

export function openLinkItems({ split = true }: { split?: boolean } = {}): MenuItem[] {
  return [
    { id: "tab", title: t("Open in New Tab"), symbol: OPEN_SYMBOLS.tab },
    ...(split && splitViewAvailable ? [{ id: "split", title: t("Open in Split View"), symbol: OPEN_SYMBOLS.split }] : []),
    {
      id: "openIn",
      title: t("Open in"),
      symbol: "macwindow",
      children: [
        { id: "window", title: t("New Window"), symbol: OPEN_SYMBOLS.window },
        { id: "incognito", title: t("Incognito Window"), symbol: OPEN_SYMBOLS.incognito },
      ],
    },
  ];
}

export function openAllItems(links: number, label: "All" | number = "All", { elsewhere = true }: { elsewhere?: boolean } = {}): MenuItem[] {
  const all = label === "All";
  return [
    {
      id: "openAll",
      title: all ? t("Open All in New Tabs") : label === 1 ? t("Open {count} in New Tab", { count: label }) : t("Open {count} in New Tabs", { count: label }),
      symbol: OPEN_SYMBOLS.tab,
      enabled: links > 0,
    },
    ...(elsewhere
      ? [
          { id: "openAllWindow", title: all ? t("Open All in New Window") : t("Open {count} in New Window", { count: label }), symbol: OPEN_SYMBOLS.window, enabled: links > 0 },
          { id: "openAllIncognito", title: all ? t("Open All in Incognito Window") : t("Open {count} in Incognito Window", { count: label }), symbol: OPEN_SYMBOLS.incognito, enabled: links > 0 },
        ]
      : []),
  ];
}

export function copyLinkItems(count = 1): MenuEntry[] {
  return withOptionAlternate(
    { id: "copy", title: count === 1 ? t("Copy Link") : t("Copy {count} Links", { count }), symbol: "link", enabled: count > 0 },
    { id: "copyMarkdown", title: count === 1 ? t("Copy Link as Markdown") : t("Copy {count} Links as Markdown", { count }), symbol: "link", enabled: count > 0 },
  );
}

const OPEN_ALL_MODES: Record<string, OpenAllMode> = { openAll: "tabs", openAllWindow: "window", openAllIncognito: "incognito" };

export const openAllModeOf = (id: string): OpenAllMode | undefined => OPEN_ALL_MODES[id];
const OPEN_ONE_MODES = { tab: "foreground", window: "window", incognito: "incognito", split: "split" } as const;

export function runLinkChoice(choice: string | null, links: Link[], windowId: string, manyMessage?: string): boolean {
  if (!choice) return false;
  const one = links.length === 1 ? links[0] : undefined;
  if (one && choice in OPEN_ONE_MODES) {
    openUrl(one.url, windowId, OPEN_ONE_MODES[choice as keyof typeof OPEN_ONE_MODES]);
    return true;
  }
  if (choice in OPEN_ALL_MODES) {
    void openLinks(links, windowId, OPEN_ALL_MODES[choice], manyMessage);
    return true;
  }
  if (choice === "copy" || choice === "copyMarkdown") {
    copyLinks(links, choice === "copyMarkdown");
    return true;
  }
  return false;
}

export function copyLinks(links: Link[], markdown: boolean) {
  if (!links.length) return;
  const lines = links.map((l) => (markdown ? markdownLink(l.title ?? "", l.url) : cleanUrl(l.url)));
  copyLink(linkLines(lines, markdown));
}
