import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { test } from "node:test";
import { MENU_OPENERS, OPENER_DEFINITIONS } from "../components/ui/menuOpeners.ts";

const COMPONENTS = join(import.meta.dirname, "..", "components");

type Over = "frostable" | "page" | "sheet" | "system" | "card";

const OPENERS = new Set<string>(MENU_OPENERS);

const DEFINITIONS: readonly string[] = OPENER_DEFINITIONS;

const OPAQUE_WRAPPERS = new Set(["TabsMenuTrigger", "PressMenu", "MoreMenu"]);

const SITES: Record<string, Over[]> = {
  "browsing/BottomBar.tsx": ["page"],
  "browsing/BrowsingScreen.tsx": ["page", "page"],
  "browsing/FloatingBar.tsx": ["page"],
  "browsing/MaterialPageMenu.tsx": ["sheet"],
  "browsing/PageMenu.tsx": ["sheet"],
  "browsing/PageMenuWords.tsx": ["sheet"],
  "browsing/PageRequests.tsx": ["card", "page"],
  "browsing/ReaderView.tsx": ["page", "page"],
  "browsing/tabsMenu.tsx": ["page", "page"],
  "duo/DuoBrowsing.tsx": ["page"],
  "duo/DuoSidebar.tsx": ["page", "page", "card", "page", "page", "page"],
  "library/ExpoLibrary.tsx": ["system", "system", "system", "system"],
  "library/LibraryView.tsx": ["sheet", "sheet", "card"],
  "library/MaterialLibrary.tsx": ["sheet"],
  "search/MaterialSearchView.tsx": ["page"],
  "search/SearchTray.tsx": ["page"],
  "search/StartPage.tsx": ["frostable"],
  "search/StartScreen.tsx": ["frostable"],
  "search/StartSpaces.tsx": ["frostable"],
  "settings/BlockingPages.tsx": ["card", "card"],
  "settings/DataPages.tsx": ["card"],
  "settings/SettingsKit.tsx": ["sheet"],
  "sync/ExpoSpaces.tsx": ["system", "system"],
  "sync/SpacesView.tsx": ["sheet"],
  "sync/SyncPage.tsx": ["card"],
  "tabs/ArchiveIntervalCard.tsx": ["frostable", "frostable"],
  "tabs/ArchiveView.tsx": ["sheet", "sheet", "sheet", "card"],
  "tabs/ContainedDeck.tsx": ["frostable"],
  "tabs/DeckBottomBar.tsx": ["frostable", "frostable"],
  "tabs/DeckCard.tsx": ["frostable", "frostable", "frostable"],
  "tabs/DeckHeader.tsx": ["frostable", "frostable", "frostable"],
  "tabs/ExpoArchive.tsx": ["system", "system", "system"],
  "tabs/MaterialDeckCard.tsx": ["frostable"],
  "tabs/MaterialDeckChrome.tsx": ["frostable", "frostable", "frostable"],
  "tabs/TabDeck.tsx": ["frostable", "frostable", "frostable", "card", "frostable"],
  "tabs/TabGrid.tsx": ["frostable"],
  "ui/MaterialBottomBar.tsx": ["page", "page"],
};

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith(".tsx") && !name.includes(".test.") ? [path] : [];
  });
}

type Site = { name: string; tag: string };

export function menuSites(source: string): Site[] {
  const sites: Site[] = [];
  for (const start of source.matchAll(/(?<![\w.])<([A-Z][\w.]*)/g)) {
    const name = start[1]!;
    if (!OPENERS.has(name)) continue;
    let depth = 0;
    let at = start.index! + start[0].length;
    for (; at < source.length; at++) {
      const char = source[at];
      if (char === "{") depth++;
      else if (char === "}") depth--;
      else if (char === ">" && depth === 0 && source[at - 1] !== "=") break;
    }
    sites.push({ name, tag: source.slice(start.index!, at + 1) });
  }
  return sites;
}

const sitesIn = (file: string) => menuSites(readFileSync(join(COMPONENTS, file), "utf8"));

test("every place that opens a menu, each element in each file, is listed with what it floats over, so a new one has to choose its material", () => {
  const found = Object.fromEntries(
    sources(COMPONENTS)
      .map((file) => relative(COMPONENTS, file).split(sep).join("/"))
      .filter((file) => !DEFINITIONS.includes(file))
      .map((file) => [file, sitesIn(file).length] as const)
      .filter(([, count]) => count > 0)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  const listed = Object.fromEntries(Object.entries(SITES).map(([file, overs]) => [file, overs.length] as const).sort(([a], [b]) => a.localeCompare(b)));
  assert.deepEqual(found, listed);
});

test("every drawn menu over a page or the Reader is opaque, since a WebView can't be frosted and would show sharp through the panel", () => {
  const frosted = Object.entries(SITES).flatMap(([file, overs]) =>
    sitesIn(file)
      .filter((site, at) => overs[at] === "page" && !OPAQUE_WRAPPERS.has(site.name) && !/frost=\{null\}/.test(site.tag))
      .map((site) => `${file}: <${site.name}>`),
  );
  assert.deepEqual(frosted, []);
});

test("the inventory counts sites of the registered menu openers: a second one in a listed file is found, a component that only has Menu in its name is not", () => {
  assert.equal(menuSites('<MenuTrigger items={a}>{() => null}</MenuTrigger>\n<MenuTrigger items={b}>{() => null}</MenuTrigger>').length, 2);
  assert.deepEqual(
    menuSites('const x = useState<RowMenu | null>(null);\n<PlusMenuButton width={1} onMenu={(open) => setOpen(open)} />\n<MenuShortcutHint />\n<ContextMenu.Items />').map((site) => site.name),
    ["PlusMenuButton"],
  );
  assert.deepEqual(menuSites("<ConfirmSheet confirmation={c} onClose={close} />").map((site) => site.name), ["ConfirmSheet"]);
});
