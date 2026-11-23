import type { MenuSlot, PanelMode, PluginManifest } from "../../lib/pluginManifest";
import { isDecideEvent } from "../automation/eventNames";
import { consentLine, listed, type ConsentLine } from "./consentLine";

const SLOT_WORDS: Record<MenuSlot, string> = { tab: "tabs", group: "groups" };
const MODE_WORDS: Record<PanelMode, string> = { sidecar: "a side panel", tab: "a tab", split: "Split View" };

export function contributionLines(m: PluginManifest, slots: readonly MenuSlot[]): ConsentLine[] {
  const k = m.contributes;
  const lines: ConsentLine[] = [];
  const menuSlots = slots.filter((slot) => k.menus[slot].length);
  if (menuSlots.length) lines.push(consentLine("does", "ellipsis.circle", `Adds to the menu you get on ${listed(menuSlots.map((slot) => SLOT_WORDS[slot]))}`));
  if (k.toolbar.length) lines.push(consentLine("does", "menubar.rectangle", k.toolbar.length === 1 ? "Adds a button to the toolbar" : `Adds ${k.toolbar.length} buttons to the toolbar`, { items: k.toolbar.map((t) => t.title) }));
  if (k.sidebarViews.length) lines.push(consentLine("does", "sidebar.left", "Adds to the sidebar", { items: k.sidebarViews.map((v) => v.title) }));
  const extraPanels = k.panels.filter((p) => !(m.page && p.file === m.page.source.file && p.title === m.page.title));
  if (extraPanels.length) lines.push(consentLine("does", "rectangle.righthalf.inset.filled", "Adds panels", { items: extraPanels.map((p) => `${p.title} (in ${MODE_WORDS[p.mode]})`) }));
  if (k.themes.length) lines.push(consentLine("does", "paintpalette", "Offers themes", { items: k.themes.map((t) => t.title) }));
  if (k.omnibox.length)
    lines.push(
      consentLine("reaches", "magnifyingglass", `Suggests results in the address bar${k.omnibox.some((o) => o.global) ? " as you type" : ""}`, {
        items: k.omnibox.map((o) => (o.keyword ? `${o.title} (${o.keyword})` : o.title)),
        detail: "What you type there goes to the plugin",
      }),
    );
  const deciding = k.hooks.filter(isDecideEvent);
  if (deciding.length) lines.push(consentLine("reaches", "arrow.triangle.swap", "Can stop or redirect", { items: deciding, code: true }));
  if (k.settings.rows.some((r) => r.type === "secret")) lines.push(consentLine("reaches", "lock.shield", "Asks for secrets in its settings", { detail: "They stay in your Keychain" }));
  return lines;
}
