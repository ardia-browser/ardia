import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const { arcSelectedFill, colorRoles, fieldInk } = await import("./tokens.ts");
const { caretColor, caretColorOnRow, popoverFieldSurface, quietBarGlyph, quietGoLabel, contrastTheme, profileTheme } = await import("./theme.ts");
const { contrastRatio, over } = await import("../../lib/color.ts");

const shown = (color, surface) => contrastRatio(over(color, surface), surface);
const stock = (dark) => profileTheme({ color: "plum" }, dark);
const barOf = (theme) => theme.ntpBarSolid;
const idleGoOf = (theme) => over(theme.goButtonIdle, theme.ntpBarSolid);

test("on the stock bar the caret is Dia's opaque ink and reads at 4:1 in both modes, not the selection wash", () => {
  for (const dark of [false, true]) {
    const theme = stock(dark), caret = caretColor(theme);
    assert.equal(caret, fieldInk.caret[dark ? "dark" : "light"]);
    assert.notEqual(caret, theme.selection);
    assert.ok(shown(caret, barOf(theme)) >= 4, `${dark ? "dark" : "light"} caret on the bar fill: ${shown(caret, barOf(theme)).toFixed(2)}`);
  }
});

test("on the stock bar the quiet glyphs keep their measured inks: 3:1 in light on the bar and on a disabled Go's fill, dark unchanged", () => {
  const light = stock(false), dark = stock(true);
  assert.equal(quietBarGlyph(light), fieldInk.quietGlyphLight);
  assert.equal(quietGoLabel(light), fieldInk.quietGlyphLight);
  assert.ok(shown(quietBarGlyph(light), barOf(light)) >= 3, `Dictate on the light bar: ${shown(quietBarGlyph(light), barOf(light)).toFixed(2)}`);
  assert.ok(shown(quietGoLabel(light), idleGoOf(light)) >= 3, `disabled Go on its light fill: ${shown(quietGoLabel(light), idleGoOf(light)).toFixed(2)}`);
  assert.ok(shown(quietBarGlyph(light), barOf(light)) >= shown(quietBarGlyph(dark), barOf(dark)), "light reads at least as well as dark");
  assert.equal(quietBarGlyph(dark), dark.textTertiary, "dark keeps its look on the bar");
  assert.equal(quietGoLabel(dark), dark.textTertiary, "and on a disabled Go");
  assert.ok(shown(quietBarGlyph(contrastTheme(light)), barOf(light)) >= shown(quietBarGlyph(light), barOf(light)), "Increase Contrast only strengthens it");
  assert.equal(colorRoles.light.textTertiary, "#00000059", "the shared tertiary role is unchanged");
});

test("a custom light palette whose bar matches the caret ink gets a readable caret and quiet glyphs, never a 1:1 one", () => {
  const custom = { ...stock(false), ntpBarSolid: "#787D86", textPrimary: "#FFFFFF", goButtonIdle: "rgba(0,0,0,0.06)" };
  assert.ok(shown(fieldInk.caret.light, custom.ntpBarSolid) < 1.1, "the stock caret would vanish on it");
  assert.ok(shown(caretColor(custom), barOf(custom)) >= 3, `caret: ${caretColor(custom)} at ${shown(caretColor(custom), barOf(custom)).toFixed(2)}`);
  assert.ok(shown(quietBarGlyph(custom), barOf(custom)) >= 3, `Dictate: ${quietBarGlyph(custom)}`);
  assert.ok(shown(quietGoLabel(custom), idleGoOf(custom)) >= 3, `disabled Go: ${quietGoLabel(custom)}`);
  const dim = { ...stock(true), ntpBarSolid: "#F2F2F2", panel: "#F2F2F2" };
  assert.ok(shown(caretColor(dim), barOf(dim)) >= 3, `a light bar in dark mode: ${caretColor(dim)}`);
  assert.ok(shown(caretColor(dim, "panel"), dim.panel) >= 3, "a field on another surface is checked against that surface");
});

test("a form field's caret is resolved against the field fill it paints, not the bar's, and keeps the stock ink on the stock fill", () => {
  for (const dark of [false, true]) {
    const theme = stock(dark);
    assert.equal(caretColor(theme, "field"), fieldInk.caret[dark ? "dark" : "light"], `${dark ? "dark" : "light"} stock field`);
  }
  const custom = { ...stock(false), field: "#787D86", ntpBarSolid: "#FEFFFF", textPrimary: "#FFFFFF" };
  assert.equal(caretColor(custom), fieldInk.caret.light, "the bar itself is untouched");
  const onField = caretColor(custom, "field");
  assert.ok(shown(onField, custom.field) >= 3, `caret on the custom field fill: ${onField} at ${shown(onField, custom.field).toFixed(2)}`);
  const field = readFileSync(fileURLToPath(new URL("./Field.tsx", import.meta.url)), "utf8");
  assert.equal((field.match(/cursorColor=\{caretColor\(theme, (?:bare \? surface : )?"field"\)\}/g) ?? []).length, 2, "SearchField and TextField pass the field fill they paint");
});

test("every text field that sets a selection colour sets its caret too", () => {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".tsx")) files.push(path);
    }
  };
  walk(fileURLToPath(new URL("..", import.meta.url)));
  const missing = files.filter((file) => {
    const source = readFileSync(file, "utf8");
    return (source.match(/selectionColor=/g) ?? []).length > (source.match(/cursorColor=/g) ?? []).length;
  });
  assert.ok(files.length > 50, `walked the components: ${files.length}`);
  assert.deepEqual(missing, []);
});

test("a bare search field's caret is resolved against the surface it sits on: the Search Tabs and group panels, and the empty split pane's row", async () => {
  const { emptyPaneFieldSurface } = await import("../split/tokens.ts");
  for (const dark of [false, true]) assert.equal(caretColor(stock(dark), "panel"), fieldInk.caret[dark ? "dark" : "light"], "the stock panel keeps the stock ink");
  const custom = { ...stock(false), panel: "#787D86", textPrimary: "#FFFFFF" };
  const onPanel = caretColor(custom, "panel");
  assert.ok(shown(onPanel, custom.panel) >= 3, `caret on a #787D86 panel: ${onPanel} at ${shown(onPanel, custom.panel).toFixed(2)}`);
  const rowHover = { ...stock(false), rowHover: "#787D86", textPrimary: "#FFFFFF" };
  const onRow = caretColor(rowHover, emptyPaneFieldSurface);
  assert.ok(shown(onRow, emptyPaneFieldSurface(rowHover)) >= 3, `caret on the empty pane's row: ${onRow}`);
  assert.equal(caretColor(stock(false), emptyPaneFieldSurface), fieldInk.caret.light, "the stock empty pane keeps the stock ink");
  const callers = { "../sidebar/SearchTabs.tsx": /look="bare"\s+surface="panel"/, "../sidebar/GroupPanel.tsx": /look="bare"\s+surface=\{popoverFieldSurface\}/, "../split/SplitEmptyState.tsx": /look="bare"\s+surface=\{emptyPaneFieldSurface\}/ };
  for (const [file, pattern] of Object.entries(callers)) assert.match(readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8"), pattern, file);
  const bareCallers = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".tsx") && /<SearchField[^>]*look="bare"/s.test(readFileSync(path, "utf8").replace(/\n/g, " "))) bareCallers.push(path);
    }
  };
  walk(fileURLToPath(new URL("..", import.meta.url)));
  assert.equal(bareCallers.length, 3, `every bare SearchField is one of the three above: ${bareCallers}`);
});

test("the group search sits on the popover's own material: a #787D86 popover tint and a black fill under the menu material get readable carets, and the stock popover keeps the stock ink", async () => {
  const { PROFILE_COLOR_NAMES } = await import("../../lib/profileLook.ts");
  for (const dark of [false, true]) for (const color of PROFILE_COLOR_NAMES) {
    assert.equal(caretColor(profileTheme({ color }, dark), popoverFieldSurface), fieldInk.caret[dark ? "dark" : "light"], `${color} ${dark ? "dark" : "light"}`);
  }
  const tinted = { ...stock(false), popoverTint: "#787D86", panel: "#FFFFFF", textPrimary: "#FFFFFF" };
  const caret = caretColor(tinted, popoverFieldSurface);
  assert.ok(shown(caret, popoverFieldSurface(tinted)) >= 3, `caret on a #787D86 popover tint: ${caret} at ${shown(caret, popoverFieldSurface(tinted)).toFixed(2)}`);
  const darkFill = { ...stock(false), popoverFill: "#000000", popoverTint: "#00000000", panel: "#FFFFFF" };
  const painted = popoverFieldSurface(darkFill);
  assert.equal(painted, "#B1B1B1", "translucent light menu material over a black popover fill paints #B1B1B1");
  assert.ok(shown(fieldInk.caret.light, painted) < 2, `the stock caret fails contrast on ${painted}`);
  const onMenuMaterial = caretColor(darkFill, popoverFieldSurface);
  assert.ok(shown(onMenuMaterial, painted) >= 3, `caret on the painted menu material: ${onMenuMaterial} at ${shown(onMenuMaterial, painted).toFixed(2)}`);
});

test("a sidebar rename field reads its caret against the row it sits in: a #787D86 selected tab and an opaque #787D86 light profile get readable carets, and every stock row keeps the stock ink", async () => {
  const { PROFILE_COLOR_NAMES, hexColor } = await import("../../lib/profileLook.ts");
  for (const dark of [false, true]) for (const color of PROFILE_COLOR_NAMES) {
    const theme = profileTheme({ color }, dark), mode = dark ? "dark" : "light";
    assert.equal(caretColorOnRow(theme, theme.tabSelected, arcSelectedFill[mode]), fieldInk.caret[mode], `${color} ${mode}: the selected row`);
    assert.equal(caretColorOnRow(theme, "#00000000"), fieldInk.caret[mode], `${color} ${mode}: a plain row`);
    assert.equal(caretColorOnRow(theme, theme.tabPressed, colorRoles[mode].tabPressed), fieldInk.caret[mode], `${color} ${mode}: a folder taking a drop`);
  }
  const custom = { ...stock(false), tabSelected: "#787D86", textPrimary: "#FFFFFF" };
  const caret = caretColorOnRow(custom, custom.tabSelected, arcSelectedFill.light);
  const worst = Math.min(...custom.windowTint.map((tint) => shown(caret, over(custom.tabSelected, tint))));
  assert.ok(worst >= 3, `caret on a #787D86 selected tab: ${caret} at ${worst.toFixed(2)}`);
  const opaqueGrey = profileTheme({ color: "plum", theme: { mode: "light", stops: [{ color: hexColor("#787D86"), x: 0.5, y: 0.5 }], intensity: 1, grain: 0, texture: "grain", translucency: 0 } }, false);
  assert.ok(Math.min(...opaqueGrey.windowTint.map((tint) => shown(fieldInk.caret.light, tint))) < 1.1, "the stock light caret vanishes on an opaque #787D86 profile");
  const inactiveCaret = caretColorOnRow(opaqueGrey, "#00000000");
  const inactiveWorst = Math.min(...opaqueGrey.windowTint.map((tint) => shown(inactiveCaret, tint)));
  assert.ok(inactiveWorst >= 3, `inactive tab or group rename on an opaque #787D86 light profile: ${inactiveCaret} at ${inactiveWorst.toFixed(2)}`);
  const tabRow = readFileSync(fileURLToPath(new URL("../sidebar/TabRow.tsx", import.meta.url)), "utf8");
  assert.match(tabRow, /surface=\{fill\}\s+stockSurface=\{active && !quiet \? arcSelectedFill\[theme\.dark \? "dark" : "light"\] : fill\}/, "the tab row passes the fill it paints");
  assert.match(tabRow, /cursorColor=\{caretColorOnRow\(theme, surface, stockSurface\)\}/);
  assert.match(readFileSync(fileURLToPath(new URL("../sidebar/GroupBlock.tsx", import.meta.url)), "utf8"), /<RenameField[^>]*surface=\{dropInto \? theme\.tabPressed : ink\.clear\}/s, "the group header passes its fill");
});

test("the macOS multiline editor patch keeps selected text in the field's foreground ink", () => {
  const patch = readFileSync(fileURLToPath(new URL("../../../../../patches/react-native-macos@0.81.9.patch", import.meta.url)), "utf8");
  const start = patch.indexOf("diff --git a/Libraries/Text/TextInput/Multiline/RCTUITextView.mm");
  assert.ok(start >= 0, "RCTUITextView.mm is patched");
  const end = patch.indexOf("diff --git ", start + 1);
  const section = patch.slice(start, end > 0 ? end : undefined);
  assert.match(section, /selectTextAttributes\[NSForegroundColorAttributeName\] = _defaultTextAttributes\[NSForegroundColorAttributeName\] \?: \[NSColor selectedTextColor\];/);
  assert.match(section, /\[self ardia_refreshSelectionLook\];/);
});
