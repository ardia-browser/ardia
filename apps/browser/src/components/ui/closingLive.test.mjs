import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const components = new URL("../", import.meta.url);
const source = (file) => readFileSync(new URL(file, components), "utf8");

const CLOSING_PANELS = [
  "bookmarks/FolderMenu.tsx",
  "bookmarks/FolderMenus.tsx",
  "pages/BookmarksPage.tsx",
  "plugins/PluginOverlays.tsx",
  "split/SplitChrome.tsx",
  "downloads/Downloads.tsx",
  "downloads/FooterButton.tsx",
  "find/FindBar.tsx",
  "iconPicker/IconGrid.tsx",
  "iconPicker/IconPickerPanel.tsx",
  "media/CastPicker.tsx",
  "ntp/Personalize.tsx",
  "onboarding/OptionCard.tsx",
  "onboarding/Parts.tsx",
  "onboarding/Personalize.tsx",
  "plugins/PluginSurface.tsx",
  "plugins/SurfaceActions.tsx",
  "plugins/SurfaceBasics.tsx",
  "plugins/SurfaceDetail.tsx",
  "plugins/SurfaceForm.tsx",
  "plugins/SurfaceList.tsx",
  "plugins/SurfaceMarkdown.tsx",
  "plugins/SurfaceSidebar.tsx",
  "profiles/ProfileIconPicker.tsx",
  "settings/ThemeControls.tsx",
  "settings/ThemeEditor.tsx",
  "sidebar/FolderPanel.tsx",
  "sidebar/IconPicker.tsx",
  "site/DeviceChooser.tsx",
  "site/HiddenElements.tsx",
  "site/PromptParts.tsx",
  "site/Prompts.tsx",
  "site/SiteConnection.tsx",
  "site/SiteControls.tsx",
  "site/SiteControlsParts.tsx",
  "site/SiteExtensions.tsx",
  "site/ZoomControls.tsx",
  "ui/Button.tsx",
  "ui/ButtonKinds.tsx",
  "ui/CheckTarget.tsx",
  "ui/Checkbox.tsx",
  "ui/Closing.tsx",
  "ui/Field.tsx",
  "ui/ListRow.tsx",
  "ui/Menu.tsx",
  "ui/Popover.tsx",
  "ui/Row.tsx",
  "ui/Segmented.tsx",
  "ui/Switch.tsx",
  "ui/Toast.tsx",
  "window/HistoryPopover.tsx",
  "window/NewTabNotice.tsx",
  "window/PageOverlays.tsx",
];

const HOSTS = ["Pressable", "TextInput", "MouseArea", "ContextMenuArea", "OutsidePressArea", "View", "Animated.View", "ScrollView", "NativeText", "Text"];
const ACTIONS = /^on(Press|LongPress|KeyDown|KeyUp|ContextMenu|DoubleClick|MiddleClick|ChangeText|SubmitEditing|AccessibilityAction|AccessibilityTap|OutsidePress|StartShouldSetResponder|MoveShouldSetResponder)$/;
const READS_CLOSING = /\b(useClosing|useLiveAction|useLiveWhile|whileOpen|ClosingView|ClosingScope|useClosingField|usePopoverPresence|usePopoverPresenceOf|usePanelsPresence)\b|\bclosing=/;

function closingBrace(text, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}

function openingTags(text) {
  const tags = [];
  const start = new RegExp(`<(${HOSTS.map((h) => h.replace(".", "\\.")).join("|")})(?=[\\s>/])`, "g");
  for (const match of text.matchAll(start)) {
    const attributes = [];
    let i = match.index + match[0].length;
    while (i < text.length && text[i] !== ">") {
      if (text[i] === "{") {
        i = closingBrace(text, i) + 1;
        continue;
      }
      const name = /^([A-Za-z-]+)=\{/.exec(text.slice(i));
      if (name) {
        const open = i + name[1].length + 1;
        const end = closingBrace(text, open);
        attributes.push({ name: name[1], value: text.slice(open + 1, end).trim() });
        i = end + 1;
        continue;
      }
      if (text[i] === '"') i = text.indexOf('"', i + 1);
      i++;
    }
    tags.push({ host: match[1], line: text.slice(0, match.index).split("\n").length, attributes });
  }
  return tags;
}

const OUTSIDE_ITS_PANEL = new Set(["ntp/Personalize.tsx <Pressable onPress={() => setOpen(open ? null : windowId)}>", "ntp/Personalize.tsx <Pressable onAccessibilityTap={tapActivates(() => setOpen(open ? null : windowId))}>"]);

const NOT_IN_A_CLOSING_PANEL = new Set(["plugins/PluginOverlays.tsx <View onKeyDown>", "split/SplitChrome.tsx <View onDoubleClick>"]);

const STOPS_PROPAGATION_ONLY = new Set(["keepActivationKeys"]);

const routed = (value) => value === "undefined" || STOPS_PROPAGATION_ONLY.has(value) || /\blive\(/.test(value);

test("every file that reads a closing state or renders a closing panel is pinned here", () => {
  const files = readdirSync(components, { recursive: true }).map((name) => name.replaceAll("\\", "/")).filter((name) => /\.tsx$/.test(name) && !name.includes("fixtures"));
  const reading = files.filter((name) => READS_CLOSING.test(source(name)));
  assert.deepEqual(reading.filter((name) => !CLOSING_PANELS.includes(name)), [], "a new closing panel or piece joins CLOSING_PANELS so its handlers are checked");
  for (const name of CLOSING_PANELS) assert.ok(files.includes(name), `${name} still exists`);
});

test("a control inside a closing panel passes its actions only through the live check", () => {
  const unguarded = CLOSING_PANELS.flatMap((file) =>
    openingTags(source(file)).flatMap(({ host, line, attributes }) => attributes.filter((a) => ACTIONS.test(a.name) && !routed(a.value) && !OUTSIDE_ITS_PANEL.has(`${file} <${host} ${a.name}={${a.value}}>`) && !NOT_IN_A_CLOSING_PANEL.has(`${file} <${host} ${a.name}>`)).map((a) => `${file}:${line} <${host} ${a.name}={${a.value}}>`)),
  );
  assert.deepEqual(unguarded, [], "a closing panel hands no callback to the host: write on…={live(handler)} (useLiveAction or useLiveWhile from ui/Closing)");
});

test("the scanner sees the handlers it guards", () => {
  const tags = openingTags(`<View onDoubleClick={live(onShare)}>\n<Pressable disabled={closing} onPress={() => go(a > b)} onKeyDown={live(spaceActivates(x))} {...radioA11y(on, "t")}>`);
  assert.deepEqual(
    tags.map((t) => t.attributes.map((a) => [a.name, routed(a.value)])),
    [[["onDoubleClick", true]], [["disabled", false], ["onPress", false], ["onKeyDown", true]]],
  );
  const guarded = CLOSING_PANELS.flatMap((file) => openingTags(source(file)).flatMap((t) => t.attributes.filter((a) => ACTIONS.test(a.name))));
  assert.ok(guarded.length > 60, `${guarded.length} guarded handlers`);
});

test("a pop-up's menu choice that arrives after its panel started closing is dropped", () => {
  const field = source("ui/Field.tsx");
  assert.match(field, /const stillOpen = useStillOpen\(!closing\);/);
  assert.match(field, /const choice = await showMenu\([^\n]*\);\n\s*if \(choice !== null && choice !== value && stillOpen\(\)\) onChange\(choice as T\);/);
});
