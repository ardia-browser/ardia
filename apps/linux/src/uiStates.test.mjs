import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const shims = new URL("./shims/", import.meta.url);
const packages = new URL("../../../packages/", import.meta.url);
const reactUrl = pathToFileURL(createRequire(import.meta.url).resolve("react")).href;
const recording = (real, names) =>
  "data:text/javascript," +
  encodeURIComponent(
    `import React from ${JSON.stringify(reactUrl)}; import * as real from ${JSON.stringify(real)}; export * from ${JSON.stringify(real)};
const seen = (globalThis.hostProps ??= { on: false, list: [] });
const wrap = (name) => React.forwardRef(function Recorded(props, ref) { if (seen.on) seen.list.push({ name, props }); return React.createElement(real[name], { ...props, ref }); });
${names.map((name) => `export const ${name} = wrap(${JSON.stringify(name)});`).join("\n")}`,
  );
const aliases = new Map([
  ["react-native", recording(new URL("react-native.tsx", shims).href, ["Pressable", "TextInput", "View", "ScrollView", "Text"])],
  ["@ardia/shell", recording(new URL("shell.tsx", shims).href, ["MouseArea", "ContextMenuArea", "OutsidePressArea"])],
  ["expo-modules-core", new URL("expo-modules-core.ts", shims).href],
  ...["ardiacore", "shaders", "sync", "import"].map((name) => [`@ardia/${name}`, new URL(`${name}.tsx`, shims).href]),
  ...[["shell", "index.tsx"], ["ardiacore", "index.ts"], ["shaders", "index.tsx"], ["sync", "index.ts"], ["import", "index.ts"]].map(([name, file]) => [`@ardia-real/${name}`, new URL(`${name}/src/${file}`, packages).href]),
]);
const PLATFORM_FIRST = [".linux.tsx", ".linux.ts", ".web.tsx", ".web.ts"];
const ASSET_REQUIRE = /\brequire\((["'])([^"']+\.(?:png|jpe?g|gif|webp|svg))\1\)/g;
const typescript = createRequire(import.meta.url)("typescript");

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "react-native" && context.parentURL?.startsWith(shims.href)) return { url: new URL("react-native.tsx", shims).href, shortCircuit: true };
    if (aliases.has(specifier)) return { url: aliases.get(specifier), shortCircuit: true };
    if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
      for (const ext of PLATFORM_FIRST) {
        const url = new URL(specifier + ext, context.parentURL);
        if (existsSync(url)) return { url: url.href, shortCircuit: true };
      }
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (!url.startsWith("file:") || !/\.tsx?$/.test(url) || url.includes("/node_modules/")) return next(url, context);
    const source = readFileSync(new URL(url), "utf8").replace(ASSET_REQUIRE, (_match, _quote, asset) => JSON.stringify(asset));
    const { outputText } = typescript.transpileModule(source, { fileName: fileURLToPath(url), compilerOptions: { module: typescript.ModuleKind.ESNext, target: typescript.ScriptTarget.ES2022, jsx: typescript.JsxEmit.ReactJSX } });
    return { format: "module", source: outputText, shortCircuit: true };
  },
});

await import("../../browser/src/state/telemetry/windowPlacementCounts.ts");
await import("@ardia/shell");
const { createElement: h } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const ui = await import("../../browser/src/components/ui/index.ts");

const render = (node) => renderToStaticMarkup(node);
const attributes = (tag) => Object.fromEntries([...tag.matchAll(/\s([\w-]+)(?:="([^"]*)")?/g)].map((m) => [m[1].toLowerCase(), m[2] ?? ""]));
const tags = (html) => [...html.matchAll(/<(div|button|input|textarea)\b[^>]*>/g)].map((m) => ({ tag: m[1], ...attributes(m[0]) }));
const withRole = (html, role) => tags(html).filter((t) => t.role === role);
const inlineStyles = (html) => [...html.matchAll(/style="([^"]*)"/g)].map((m) => m[1]);
const closing = (node) => h(ui.ClosingScope, { closing: true }, node);
const noop = () => {};

test("a checked menu row is a radio that publishes aria-checked, and an unchecked one says false", () => {
  const on = withRole(render(h(ui.MenuRow, { title: "Speaker", checked: true, onPress: noop })), "radio");
  const off = withRole(render(h(ui.MenuRow, { title: "Headphones", checked: false, onPress: noop })), "radio");
  assert.deepEqual([on.length, on[0]["aria-checked"]], [1, "true"]);
  assert.deepEqual([off.length, off[0]["aria-checked"]], [1, "false"]);
});

test("a menu row with a cursor highlight stays a button with no selected or checked state in the DOM", () => {
  const html = render(h(ui.MenuRow, { title: "Tab", selected: true, onPress: noop }));
  const [button] = withRole(html, "button");
  assert.equal(button["aria-selected"], undefined, html);
  assert.equal(button["aria-checked"], undefined, html);
});

test("a button that shows a chosen state publishes aria-pressed, never aria-selected", () => {
  const html = render(h(ui.Segmented, { value: "a", onChange: noop, options: [{ value: "a", title: "Left" }, { value: "b", title: "Right" }] }));
  const buttons = withRole(html, "button");
  assert.deepEqual(buttons.map((b) => [b["aria-pressed"], b["aria-selected"]]), [["true", undefined], ["false", undefined]], html);
  assert.deepEqual(ui.chosenButtonA11y(true, "Left"), { accessibilityRole: "button", accessibilityLabel: "Left", accessibilityState: { selected: true }, "aria-pressed": true });
});

test("the radio, checkbox and switch mappings give every platform its state", () => {
  assert.deepEqual(ui.radioA11y(true, "Screen 1"), { accessibilityRole: "radio", accessibilityLabel: "Screen 1", accessibilityState: { checked: true, selected: true }, "aria-checked": true });
  assert.deepEqual(ui.checkboxA11y("mixed", true, "All"), { accessibilityRole: "checkbox", accessibilityLabel: "All", accessibilityState: { checked: "mixed", disabled: true }, "aria-checked": "mixed", "aria-disabled": true });
  assert.equal(ui.switchA11y(false)["aria-checked"], false);
});

test("Space activates a radio or checkbox row once and stops the page scrolling; other keys do nothing", () => {
  let presses = 0;
  let prevented = 0;
  const key = (k) => ui.spaceActivates(() => presses++)({ nativeEvent: { key: k }, preventDefault: () => prevented++ });
  key(" ");
  key("Enter");
  key("a");
  assert.deepEqual([presses, prevented], [1, 1]);
});

test("a whole-row check target is one named checkbox with a Tab stop and its state; the mark inside it is drawing only", () => {
  const html = render(h(ui.CheckTarget, { value: true, label: "Include pages", onChange: noop }, h(ui.CheckMark, { value: true })));
  const boxes = withRole(html, "checkbox");
  assert.equal(boxes.length, 1, html);
  assert.deepEqual([boxes[0]["aria-label"], boxes[0]["aria-checked"], boxes[0].tabindex], ["Include pages", "true", "0"]);
  assert.equal(tags(html).filter((t) => t["aria-disabled"] !== undefined).length, 0, "no unnamed, disabled checkbox inside the row");
  assert.equal(tags(html).filter((t) => t.tabindex !== undefined).length, 1, html);
});

test("a disabled check target leaves the Tab order and says it is disabled, still unchecked", () => {
  const [box] = withRole(render(h(ui.CheckTarget, { value: false, disabled: true, label: "Trace", onChange: noop }, h(ui.CheckMark, { value: false, disabled: true }))), "checkbox");
  assert.deepEqual([box["aria-checked"], box["aria-disabled"], box.tabindex], ["false", "true", "-1"]);
});

test("a form checkbox publishes checked and mixed, and a ring checkbox with no onChange draws with no role", () => {
  assert.equal(withRole(render(h(ui.Checkbox, { value: true, label: "Searches", onChange: noop })), "checkbox")[0]["aria-checked"], "true");
  assert.equal(withRole(render(h(ui.Checkbox, { value: false, mixed: true, label: "All", onChange: noop })), "checkbox")[0]["aria-checked"], "mixed");
  const ring = render(h(ui.Checkbox, { look: "ring", size: "s", value: true }));
  assert.deepEqual(tags(ring).filter((t) => t.role || t.tabindex !== undefined), [], ring);
});

test("a toggle is a switch with aria-checked", () => {
  const [toggle] = withRole(render(h(ui.Toggle, { value: true, onChange: noop, accessibilityLabel: "Block pop-ups" })), "switch");
  assert.equal(toggle["aria-checked"], "true");
});

const PIECES = {
  "push button": () => h(ui.Button, { title: "Allow", onPress: noop }),
  "icon button": () => h(ui.Button, { variant: "icon", icon: "xmark", tooltip: "Close", focusable: true, onPress: noop }),
  "text button": () => h(ui.Button, { variant: "text", look: "link", title: "Scan Again", focusable: true, onPress: noop }),
  "pill button": () => h(ui.Button, { variant: "pill", title: "Reset", onPress: noop }),
  "stepper": () => h(ui.Button, { variant: "stepper", icon: "plus", tooltip: "Zoom In", onPress: noop }),
  "panel close": () => h(ui.PanelCloseButton, { onPress: noop }),
  "menu row": () => h(ui.MenuRow, { title: "Open", onPress: noop }),
  "radio menu row": () => h(ui.MenuRow, { title: "Speaker", checked: true, onPress: noop }),
  "list row": () => h(ui.ListRow, { onPress: noop }, null),
  "checkbox": () => h(ui.Checkbox, { value: true, label: "Share audio", onChange: noop }),
  "check target": () => h(ui.CheckTarget, { value: true, label: "Include pages", onChange: noop }, h(ui.CheckMark, { value: true })),
  "toggle": () => h(ui.Toggle, { value: true, onChange: noop, look: "panel" }),
  "segmented": () => h(ui.Segmented, { value: "a", onChange: noop, options: [{ value: "a", title: "A" }, { value: "b", title: "B" }] }),
  "pop-up": () => h(ui.PopUp, { value: "a", onChange: noop, options: [{ value: "a", title: "A" }] }),
  "popover value": () => h(ui.PopoverValue, { title: "This tab", onPress: noop }),
};

for (const [name, piece] of Object.entries(PIECES))
  test(`a ${name} inside a closing panel is disabled and out of the Tab order, and looks the same`, () => {
    const open = render(piece());
    const dead = render(closing(piece()));
    const live = tags(open).filter((t) => t.tabindex !== undefined);
    const gone = tags(dead).filter((t) => t.tabindex !== undefined);
    assert.ok(live.length > 0, open);
    assert.ok(live.every((t) => t["aria-disabled"] === undefined), open);
    assert.equal(gone.length, live.length, dead);
    assert.ok(gone.every((t) => t["aria-disabled"] === "true" && t.tabindex === "-1"), dead);
    assert.ok(gone.filter((t) => t.tag === "button").every((t) => t.disabled === ""), dead);
    assert.deepEqual(inlineStyles(dead), inlineStyles(open), "no dimming while closing");
  });

test("text and search fields inside a closing panel stop taking text", () => {
  for (const field of [h(ui.TextField, { value: "x", onChangeText: noop }), h(ui.SearchField, { value: "x", onChangeText: noop, placeholder: "Search" })]) {
    const [open] = tags(render(field)).filter((t) => t.tag === "input");
    const [dead] = tags(render(closing(field))).filter((t) => t.tag === "input");
    assert.equal(open.readonly, undefined);
    assert.equal(dead.readonly, "");
  }
});

test("a search field's clear button is dead while its panel closes", () => {
  const html = render(closing(h(ui.SearchField, { value: "x", onChangeText: noop, placeholder: "Search" })));
  const clear = tags(html).filter((t) => t.tabindex !== undefined);
  assert.ok(clear.length === 1 && clear[0]["aria-disabled"] === "true", html);
});

test("a closing popover marks its subtree inert and hidden, and kills the pieces inside it", () => {
  const popover = (isClosing) => render(h(ui.Popover, { width: "s", top: 0, right: 0, closing: isClosing, onDismiss: noop }, h(ui.Button, { title: "Allow", onPress: noop }), h(ui.TextField, { value: "", onChangeText: noop })));
  const open = popover(false);
  const dead = popover(true);
  assert.doesNotMatch(open, /\sinert/);
  assert.match(dead, /\sinert/);
  assert.equal(tags(open).find((t) => t.tag === "button")?.disabled, undefined, open);
  assert.equal(tags(dead).find((t) => t.tag === "button")?.disabled, "", dead);
  assert.equal(tags(dead).find((t) => t.tag === "input")?.readonly, "", dead);
});

test("a nested scope inside a closing panel stays closing", () => {
  const html = render(closing(h(ui.ClosingScope, { closing: false }, h(ui.Button, { title: "Allow", onPress: noop }))));
  assert.equal(tags(html).find((t) => t.tag === "button")?.disabled, "", html);
});

test("whileOpen drops an action once closing starts and checks the live open state when it runs", () => {
  const calls = [];
  let open = true;
  const act = ui.whileOpen(false, () => open)((n) => calls.push(n));
  act(1);
  open = false;
  act(2);
  ui.whileOpen(true)((n) => calls.push(n))(3);
  assert.deepEqual(calls, [1]);
});

const ACTIONS = ["onPress", "onLongPress", "onPressIn", "onKeyDown", "onKeyUp", "onContextMenu", "onDoubleClick", "onMiddleClick", "onChangeText", "onSubmitEditing", "onAccessibilityAction", "onAccessibilityTap", "onOutsidePress", "onStartShouldSetResponder", "onMoveShouldSetResponder"];
const KEYS = [" ", "Enter", "Escape", "ArrowDown"].map((key) => ({ nativeEvent: { key, actionName: "activate", text: "typed" }, preventDefault: noop, stopPropagation: noop }));

function hosts(node) {
  const seen = globalThis.hostProps;
  seen.list = [];
  seen.on = true;
  try {
    render(node);
  } finally {
    seen.on = false;
  }
  return seen.list;
}

const handlersOf = (recorded) => recorded.flatMap(({ name, props }) => ACTIONS.filter((key) => typeof props[key] === "function").map((key) => ({ at: `${name}.${key}`, run: props[key] })));

function fireAll(handlers) {
  for (const { run } of handlers)
    for (const event of KEYS) {
      try {
        run(event);
      } catch {}
    }
}

function spies() {
  const calls = [];
  return { calls, spy: (name) => (...args) => void calls.push(name) };
}

const SPIED = {
  "push button": (s) => h(ui.Button, { title: "Allow", onPress: s("press") }),
  "icon button": (s) => h(ui.Button, { variant: "icon", icon: "xmark", tooltip: "Close", focusable: true, onPress: s("press"), onPressIn: s("pressIn") }),
  "toolbar icon button": (s) => h(ui.Button, { variant: "icon", toolbar: true, icon: "xmark", tooltip: "Back", onPress: s("press"), onLongPress: s("long"), onContextMenu: s("menu") }),
  "link text button": (s) => h(ui.Button, { variant: "text", look: "link", title: "Scan Again", focusable: true, onPress: s("press") }),
  "plated text button": (s) => h(ui.Button, { variant: "text", look: "panel", title: "Keep", focusable: true, onPress: s("press") }),
  "prompt pill": (s) => h(ui.Button, { variant: "pill", title: "Reset", onPress: s("press") }),
  "chip pill": (s) => h(ui.Button, { variant: "pill", tone: "chip", title: "No Icon", onPress: s("press") }),
  "stepper": (s) => h(ui.Button, { variant: "stepper", icon: "plus", tooltip: "Zoom In", onPress: s("press") }),
  "panel close": (s) => h(ui.Button, { variant: "close", look: "panel", onPress: s("press") }),
  "hud close": (s) => h(ui.Button, { variant: "close", look: "hud", onPress: s("press") }),
  "art close": (s) => h(ui.Button, { variant: "close", look: "art", onPress: s("press") }),
  "menu row": (s) => h(ui.MenuRow, { title: "Open", onPress: s("press") }),
  "radio menu row": (s) => h(ui.MenuRow, { title: "Speaker", checked: false, onPress: s("press") }),
  "list row": (s) => h(ui.ListRow, { onPress: s("press"), onPressIn: s("pressIn") }, null),
  "settings row": (s) => h(ui.Row, { title: "Passwords", onPress: s("press") }),
  "form checkbox": (s) => h(ui.Checkbox, { value: false, label: "Share audio", onChange: s("change") }),
  "ring checkbox": (s) => h(ui.Checkbox, { look: "ring", value: false, label: "Pin", onChange: s("change") }),
  "check target": (s) => h(ui.CheckTarget, { value: false, label: "Include pages", onChange: s("change") }, h(ui.CheckMark, { value: false })),
  "toggle": (s) => h(ui.Toggle, { value: false, onChange: s("change"), look: "panel", asksFirst: true }),
  "segmented": (s) => h(ui.Segmented, { value: "a", onChange: s("change"), options: [{ value: "a", title: "A" }, { value: "b", title: "B" }] }),
  "pop-up": (s) => h(ui.PopUp, { value: "a", onChange: s("change"), options: [{ value: "a", title: "A" }] }),
  "popover value": (s) => h(ui.PopoverValue, { title: "Sources", onPress: s("press") }),
  "text field": (s) => h(ui.TextField, { value: "x", onChangeText: s("text"), onSubmit: s("submit"), onEscape: s("escape") }),
  "search field": (s) => h(ui.SearchField, { value: "x", placeholder: "Search", onChangeText: s("text"), onSubmit: s("submit"), onEscape: s("escape"), onArrow: s("arrow") }),
  "popover": (s) => h(ui.Popover, { width: "s", top: 0, right: 0, closing: false, onDismiss: s("dismiss") }, h(ui.Button, { title: "Allow", onPress: s("press") })),
};
const ACTS_LATER = new Set(["pop-up"]);

for (const [name, piece] of Object.entries(SPIED))
  test(`a ${name} passes its actions while open and none at all while its panel closes`, () => {
    const open = spies();
    const live = handlersOf(hosts(piece(open.spy)));
    assert.ok(live.length > 0, `${name} has handlers to strip`);
    fireAll(live);
    if (!ACTS_LATER.has(name)) assert.ok(open.calls.length > 0, `${name}: the harness reaches the action while open`);
    const shut = spies();
    const node = name === "popover" ? h(ui.Popover, { width: "s", top: 0, right: 0, closing: true, onDismiss: shut.spy("dismiss") }, h(ui.Button, { title: "Allow", onPress: shut.spy("press") })) : closing(piece(shut.spy));
    const dead = handlersOf(hosts(node));
    assert.deepEqual(dead.filter((d) => d.at !== "Pressable.onPressIn").map((d) => d.at), [], `${name} hands no action to the host while closing; onPressIn stays only for the press look`);
    fireAll(dead);
    assert.deepEqual(shut.calls, [], `${name}: Enter, Space, a press, a release or an accessibility action reach nothing while closing`);
  });

test("a toast's action is dead while the toast fades out", () => {
  const open = spies();
  fireAll(handlersOf(hosts(h(ui.Toast, { title: "Moved", action: "Undo", onAction: open.spy("undo") }))));
  assert.deepEqual(open.calls.slice(0, 1), ["undo"]);
  const shut = spies();
  const dead = handlersOf(hosts(h(ui.Toast, { title: "Moved", action: "Undo", onAction: shut.spy("undo"), closing: true }))).filter((d) => d.at !== "Pressable.onPressIn");
  assert.deepEqual(dead.map((d) => d.at), []);
});

test("useLiveAction runs a handler while open and hands the host nothing while the scope closes", () => {
  const seen = [];
  const calls = [];
  const press = (n) => calls.push(n);
  const Probe = () => (seen.push(ui.useLiveAction()(press)), null);
  render(h(Probe));
  render(closing(h(Probe)));
  assert.equal(typeof seen[0], "function");
  seen[0](1);
  assert.deepEqual(calls, [1]);
  assert.equal(seen[1], undefined);
});

test("every shared button is a button, so Space and Enter both activate it on Linux", () => {
  const buttons = {
    "unlabelled text button": h(ui.Button, { variant: "text", look: "panel", title: "Keep", focusable: true, onPress: noop }),
    "unlabelled link": h(ui.Button, { variant: "text", look: "link", title: "Scan Again", focusable: true, onPress: noop }),
    "toolbar icon button": h(ui.Button, { variant: "icon", toolbar: true, icon: "xmark", tooltip: "Back", focusable: true, onPress: noop }),
    "chip pill": h(ui.Button, { variant: "pill", tone: "chip", title: "No Icon", onPress: noop }),
    "stepper": h(ui.Button, { variant: "stepper", icon: "plus", tooltip: "Zoom In", onPress: noop }),
    "panel close": h(ui.Button, { variant: "close", look: "panel", onPress: noop }),
    "popover value": h(ui.PopoverValue, { title: "Sources", onPress: noop }),
    "list row": h(ui.ListRow, { onPress: noop }, null),
    "settings row": h(ui.Row, { title: "Passwords", onPress: noop }),
    "search field clear": h(ui.SearchField, { value: "x", placeholder: "Search", onChangeText: noop }),
  };
  for (const [name, node] of Object.entries(buttons)) {
    const html = render(node);
    const pressables = tags(html).filter((t) => t.tabindex !== undefined && t.tag !== "input");
    assert.ok(pressables.length > 0, `${name}: ${html}`);
    assert.ok(pressables.every((t) => t.role === "button" || t.tag === "button"), `${name}: ${html}`);
  }
  const [keep] = tags(render(buttons["unlabelled text button"])).filter((t) => t.tabindex === "0");
  assert.deepEqual([keep.tag, keep["aria-label"]], ["button", "Keep"]);
});

const { ZoomStepper } = await import("../../browser/src/components/site/ZoomControls.tsx");
const { OptionCard } = await import("../../browser/src/components/onboarding/OptionCard.tsx");
const { IconPickerLayer } = await import("../../browser/src/components/iconPicker/IconPickerPanel.tsx");
const { FooterButton } = await import("../../browser/src/components/downloads/FooterButton.tsx");
const { DirectionDial, Slider } = await import("../../browser/src/components/settings/ThemeControls.tsx");

const PANEL_PARTS = {
  "Zoom stepper and its Reset": () => h(ZoomStepper, { tabId: "t", zoom: 1.1 }),
  "Recent Downloads footer": (s) => h(FooterButton, { title: "View all downloads", onPress: s("footer") }),
  "Personalize layout card": (s) => h(OptionCard, { control: "radio", title: "Classic", selected: false, onPress: s("layout"), preview: h(ui.Text, null, "preview") }),
  "plain option card": (s) => h(OptionCard, { control: "radio", title: "Classic", selected: false, onPress: s("layout") }),
  "check option card": (s) => h(OptionCard, { control: "check", title: "Dock", selected: false, onPress: s("check") }),
  "theme direction dial": (s) => h(DirectionDial, { angle: 0, onChange: s("angle") }),
  "theme slider": (s) => h(Slider, { label: "Noise", value: 0.5, onChange: s("slide") }),
};

for (const [name, part] of Object.entries(PANEL_PARTS))
  test(`${name} hands no action to the host while its panel closes`, () => {
    const open = spies();
    assert.ok(handlersOf(hosts(part(open.spy))).length > 0, name);
    const shut = spies();
    const dead = handlersOf(hosts(closing(part(shut.spy))));
    assert.deepEqual(dead.filter((d) => d.at !== "Pressable.onPressIn").map((d) => d.at), [], name);
    fireAll(dead);
    assert.deepEqual(shut.calls, [], name);
  });

test("a Personalize layout card is disabled while the panel closes", () => {
  const card = (isClosing) => tags(render(h(ui.ClosingScope, { closing: isClosing }, h(OptionCard, { control: "radio", title: "Sidebar", selected: true, onPress: noop, preview: h(ui.Text, null, "preview") })))).filter((t) => t.role === "radio");
  assert.equal(card(false)[0]["aria-disabled"], undefined);
  assert.deepEqual([card(true)[0].tabindex, card(true)[0]["aria-disabled"]], ["-1", "true"]);
});

test("the Icon Picker drops its outside-dismiss target the moment it starts closing and keeps its measured room", () => {
  const picker = (isClosing, s) => h(IconPickerLayer, { current: null, symbols: [], actions: [], onChoose: s("choose"), onClose: s("close"), closing: isClosing, placeIn: () => ({ top: 0, left: 0 }) });
  const open = spies();
  const live = hosts(picker(false, open.spy));
  assert.ok(handlersOf(live).some((d) => d.at === "Pressable.onPress"), "the backdrop dismisses while open");
  assert.ok(live.some(({ name, props }) => name === "View" && props.pointerEvents === "none" && typeof props.onLayout === "function"), "the room is measured by a view that takes no presses");
  const shut = spies();
  const dead = hosts(picker(true, shut.spy));
  assert.ok(dead.some(({ name, props }) => name === "View" && typeof props.onLayout === "function" && props.pointerEvents === "none"), "the room stays measured while closing");
  const handlers = handlersOf(dead).filter((d) => d.at !== "Pressable.onPressIn");
  assert.deepEqual(handlers.map((d) => d.at), []);
  fireAll(handlersOf(dead));
  assert.deepEqual(shut.calls, []);
});
