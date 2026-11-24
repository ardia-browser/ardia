import type { MenuSlot, PanelMode, PluginManifest } from "../../lib/pluginManifest";
import { isDecideEvent } from "../automation/eventNames";

type Line = { icon: string; text: string };

const SLOT_WORDS: Record<MenuSlot, string> = { tab: "tabs", group: "groups" };
const MODE_WORDS: Record<PanelMode, string> = { sidecar: "a side panel", tab: "a tab", split: "Split View" };

const listed = (items: string[]) => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

export function contributionLines(m: PluginManifest, slots: readonly MenuSlot[]): Line[] {
  const k = m.contributes;
  const lines: Line[] = [];
  const menuSlots = slots.filter((slot) => k.menus[slot].length);
  if (menuSlots.length) lines.push({ icon: "ellipsis.circle", text: `Adds to the menu you get on ${listed(menuSlots.map((slot) => SLOT_WORDS[slot]))}` });
  if (k.toolbar.length) lines.push({ icon: "menubar.rectangle", text: `Adds ${k.toolbar.length === 1 ? "a button" : `${k.toolbar.length} buttons`} to the toolbar: ${k.toolbar.map((t) => t.title).join(", ")}` });
  if (k.sidebarViews.length) lines.push({ icon: "sidebar.left", text: `Adds to the sidebar: ${k.sidebarViews.map((v) => v.title).join(", ")}` });
  const extraPanels = k.panels.filter((p) => !(m.page && p.file === m.page.source.file && p.title === m.page.title));
  if (extraPanels.length) lines.push({ icon: "rectangle.righthalf.inset.filled", text: `Adds panels: ${extraPanels.map((p) => `${p.title} (in ${MODE_WORDS[p.mode]})`).join(", ")}` });
  if (k.omnibox.length) lines.push({ icon: "magnifyingglass", text: `Suggests results in the address bar${k.omnibox.some((o) => o.global) ? " as you type" : ""}: ${k.omnibox.map((o) => (o.keyword ? `${o.title} (${o.keyword})` : o.title)).join(", ")}. What you type there goes to the plugin` });
  if (k.themes.length) lines.push({ icon: "paintpalette", text: `Offers themes: ${k.themes.map((t) => t.title).join(", ")}` });
  const deciding = k.hooks.filter(isDecideEvent);
  if (deciding.length) lines.push({ icon: "arrow.triangle.swap", text: `Can stop or redirect ${deciding.join(", ")}` });
  if (k.settings.rows.some((r) => r.type === "secret")) lines.push({ icon: "lock.shield", text: "Asks for secrets in its settings, which stay in your Keychain" });
  return lines;
}
