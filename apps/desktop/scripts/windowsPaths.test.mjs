import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfigFromFile } from "vite";
import { keyedPaths, pathKey, pathKeys, posixFilePath, toPosixPath } from "../desktopPaths.ts";
import { inputAdapters } from "../inputAdapters.ts";

const root = posixFilePath(new URL("../", import.meta.url));
const browser = posixFilePath(new URL("../../browser/src/", import.meta.url));
const windowsStyle = (path) => path.replaceAll("/", "\\");

const desktopPlugins = async (mode) => {
  const loaded = await loadConfigFromFile({ command: "build", mode }, fileURLToPath(new URL("../vite.config.ts", import.meta.url)), undefined, "silent");
  const plugins = loaded.config.plugins.flat(Infinity).filter(Boolean);
  const named = (name) => plugins.find((plugin) => plugin.name === name);
  return { components: named("ardia-desktop:components"), lazy: named("ardia-desktop:lazy-components"), requires: named("ardia-desktop:requires") };
};
const resolvingTo = (id) => ({ resolve: async () => ({ id }) });

test("a Windows file URL becomes the forward-slash path Vite uses for module ids", () => {
  assert.equal(posixFilePath("file:///C:/ardia/apps/browser/src/App.tsx", true), "C:/ardia/apps/browser/src/App.tsx");
  assert.equal(posixFilePath("file:///home/ardia/apps/browser/src/App.tsx", false), "/home/ardia/apps/browser/src/App.tsx");
  assert.equal(toPosixPath("C:\\ardia\\apps\\desktop\\src\\host.ts"), "C:/ardia/apps/desktop/src/host.ts");
  for (const [shared, adapter] of inputAdapters) for (const path of [shared, adapter]) assert.ok(!path.includes("\\"), path);
});

test("a drive letter in either case keys the same path, and nothing else in the path changes case", () => {
  assert.equal(pathKey("C:\\Ardia\\apps\\browser\\src\\App.tsx"), "c:/Ardia/apps/browser/src/App.tsx");
  assert.equal(pathKey("c:/Ardia/apps/browser/src/App.tsx"), pathKey("C:/Ardia/apps/browser/src/App.tsx"));
  assert.notEqual(pathKey("c:/ardia/App.tsx"), pathKey("C:/Ardia/App.tsx"));
  assert.equal(pathKey("\0ardia-lazy:C:/r/Overlays.tsx\0D:\\r\\Pane.tsx"), "\0ardia-lazy:c:/r/Overlays.tsx\0d:/r/Pane.tsx");
  for (const untouched of ["/home/ardia/App.tsx", "https://ardia.dev/switches.json", "ardia-lazy:/r/a.tsx"]) assert.equal(pathKey(untouched), untouched);
  const adapters = keyedPaths([["C:/Ardia/apps/browser/src/lib/keys.ts", "C:/Ardia/apps/desktop/src/clickModifiers.ts"]]);
  assert.equal(adapters.get(pathKey("c:\\Ardia\\apps\\browser\\src\\lib\\keys.ts")), "C:/Ardia/apps/desktop/src/clickModifiers.ts");
  assert.ok(pathKeys(["c:/Ardia/a.ts"]).has(pathKey("C:\\Ardia\\a.ts")));
});

for (const mode of ["linux", "win"]) {
  test(`--mode ${mode} routes backslash module ids through the same adapters as forward-slash ones`, { timeout: 60000 }, async () => {
    const { components, lazy, requires } = await desktopPlugins(mode);
    const [shared, adapter] = [...inputAdapters][0];
    const importer = `${browser}components/settings/panes/Shortcuts.tsx`;
    for (const [id, from] of [[shared, importer], [windowsStyle(shared), windowsStyle(importer)]]) {
      assert.equal(await components.resolveId.call(resolvingTo(id), "./anything", from, {}), adapter, `${id} from ${from}`);
    }
    const hoverCard = `${browser}components/sidebar/HoverCard.tsx`;
    assert.equal(await components.resolveId.call(resolvingTo(windowsStyle(hoverCard)), "./HoverCard", windowsStyle(`${browser}components/sidebar/Sidebar.tsx`), {}), `${root}src/SidebarHoverCard.tsx`);
    const utility = `${browser}components/settings/UtilityWindow.tsx`;
    assert.equal(await lazy.resolveId.call(resolvingTo(windowsStyle(utility)), "./UtilityWindow", windowsStyle(`${browser}App.tsx`), {}), `\0ardia-lazy:${utility}`);
    const glyphs = `const label = "⇧⌘S";`;
    const reworded = components.transform.call({}, glyphs, windowsStyle(`${browser}components/toolbar/Example.tsx`));
    assert.equal(reworded?.code, `const label = "Ctrl+Shift+S";`);
    const required = requires.transform.call({}, `const icon = require("./icon.png");`, windowsStyle(`${browser}components/Example.tsx`));
    assert.match(required?.code ?? "", /import \* as __required0 from "\.\/icon\.png";/);
  });
}
