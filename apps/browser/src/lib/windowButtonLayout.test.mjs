import assert from "node:assert/strict";
import { test } from "node:test";
const { BROWSER_BUTTON_LAYOUT, buttonLayoutCount, buttonLayoutSide, parseButtonLayout, windowButtonsFor, windowControlsWidth } = await import("./windowButtonLayout.ts");

const parsed = (raw) => {
  const { leading, trailing } = parseButtonLayout(raw);
  return [leading.join(","), trailing.join(",")].join(":");
};

test("real desktops' GTK button layouts become Ardia's buttons in their order and on their side, with the … always at the right", () => {
  const desktops = [
    [":minimize,maximize,close", ":menu,minimize,maximize,close", "Ubuntu, Pop!_OS, Zorin and today's default: the … at the inner end of the right group"],
    ["appmenu:close", ":menu,close", "upstream GNOME: the app menu token doesn't move the …, which stays beside close"],
    ["menu:close", ":menu,close", "Omarchy reports the window menu token; the … stays at the right all the same"],
    ["close,minimize,maximize:", "close,minimize,maximize:menu", "macOS-like: the buttons at the left, the … alone at the right"],
    ["close:maximize", "close:menu,maximize", "elementary OS: both sides, the … beside the right group"],
    ["icon:minimize,maximize,close", ":menu,minimize,maximize,close", "the icon isn't drawn"],
    ["close,maximize,minimize:menu", "close,maximize,minimize:menu", "a menu token at the right changes nothing"],
    [":minimize,spacer,maximize,close", ":menu,minimize,maximize,close", "spacers take no room"],
    ["", ":menu", "no buttons at all still leaves the … at the right"],
    [":", ":menu", "two empty sides are the same"],
    ["appmenu:", ":menu", "only the … is drawn, at the right"],
  ];
  for (const [raw, want, why] of desktops) assert.equal(parsed(raw), want, `${raw} — ${why}`);
});

test("GTK's own rules: no colon puts everything at the start, only the first colon splits, tokens are exact, unknown and repeated ones are dropped", () => {
  assert.equal(parsed("close,minimize"), "close,minimize:menu");
  assert.equal(parsed("close:minimize:maximize"), "close:menu", "minimize:maximize is one unknown token on the end side, as GTK reads it");
  assert.equal(parsed(":Close,MAXIMIZE"), ":menu");
  assert.equal(parsed(": close"), ":menu", "GTK doesn't trim, so ' close' is unknown");
  assert.equal(parsed(":minimize,,close"), ":menu,minimize,close");
  assert.equal(parsed("close:close,maximize"), "close:menu,maximize");
  assert.equal(parsed("appmenu,menu:close,menu"), ":menu,close", "never two …");
  assert.equal(parsed(":frobnicate,toString,constructor,close"), ":menu,close");
  for (const raw of ["appmenu:close", "menu:close", "close,minimize,maximize:", "close:maximize", ""]) assert.ok(!parseButtonLayout(raw).leading.includes("menu"), `${raw}: the left group holds only window buttons`);
});

test("an unknown layout falls back to today's buttons: …, minimize, maximize and close at the right", () => {
  for (const raw of [null, undefined]) assert.equal(parsed(raw), ":menu,minimize,maximize,close");
  assert.deepEqual(BROWSER_BUTTON_LAYOUT, { leading: [], trailing: ["menu", "minimize", "maximize", "close"] });
});

test("a window draws only the buttons it has: Settings has no …, Import can't maximize", () => {
  const { leading, trailing } = parseButtonLayout("close,maximize:minimize");
  assert.deepEqual(windowButtonsFor(leading, { menu: false }), ["close", "maximize"]);
  assert.deepEqual(windowButtonsFor(leading, { menu: false, maximizable: false }), ["close"]);
  assert.deepEqual(windowButtonsFor(trailing, { menu: true }), ["menu", "minimize"]);
  assert.deepEqual(windowButtonsFor(trailing, { menu: false, minimizable: false }), []);
  assert.equal(windowControlsWidth(0), 0);
  assert.equal(windowControlsWidth(4), 129);
});

test("telemetry reads the layout's side and how many window buttons it shows, never counting the …", () => {
  const cases = [
    [":minimize,maximize,close", "right", 3],
    ["appmenu:close", "right", 1],
    ["close,minimize,maximize:", "left", 3],
    ["close:maximize", "both", 2],
    ["appmenu:", "none", 0],
    ["menu:close", "right", 1],
    ["", "none", 0],
  ];
  for (const [raw, side, count] of cases) {
    assert.equal(buttonLayoutSide(parseButtonLayout(raw)), side, raw);
    assert.equal(buttonLayoutCount(parseButtonLayout(raw)), count, raw);
  }
});
