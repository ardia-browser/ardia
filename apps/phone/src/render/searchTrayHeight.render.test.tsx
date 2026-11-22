import { searchFieldHeight, searchPanel, searchPanelFieldBlock, searchPanelHeight, searchPanelPlace, searchTrayHeight, type SearchPanelPlacement } from "../components/search/searchPanelTokens";

const fieldHeight = searchFieldHeight(1);
const fullPanel = searchPanelHeight(fieldHeight, 1);
const resting = 300;
const safeTop = 59;

const heightFor = (placement: SearchPanelPlacement, overrides: { rowsHeight?: number; windowHeight?: number; commandBarMaxHeight?: number | null; hinged?: boolean } = {}) =>
  searchTrayHeight({
    commandBarMaxHeight: overrides.commandBarMaxHeight ?? null,
    placement,
    place: searchPanelPlace(placement, resting, overrides.hinged ?? false),
    fieldHeight,
    fontScale: 1,
    rowsHeight: overrides.rowsHeight ?? 2 * searchPanel.rowPitch,
    windowHeight: overrides.windowHeight ?? 932,
    safeTop,
    resting,
  });

test("the command bar's own height wins over every other rule, whatever the rows and the keyboard", () => {
  expect(heightFor("commandBar", { commandBarMaxHeight: 321 })).toBe(321);
  expect(heightFor("commandBar", { commandBarMaxHeight: 0, windowHeight: 2000 })).toBe(0);
});

test("the panel under the keyboard keeps its full four-row height however few rows there are, and gives way to the safe top and the gap above a new tab", () => {
  expect(heightFor("underKeyboard", { rowsHeight: 0 })).toBe(fullPanel);
  expect(heightFor("underKeyboard", { rowsHeight: 9 * searchPanel.rowPitch })).toBe(fullPanel);
  const short = 600;
  expect(heightFor("underKeyboard", { windowHeight: short })).toBe(short - safeTop - searchPanel.gapAboveNewTab - resting);
  expect(heightFor("underKeyboard", { windowHeight: short, hinged: true })).toBe(short - safeTop - searchPanel.gapAboveNewTab - resting);
});

test("the card above the keyboard grows with its rows up to the four-row panel, and stops short of the safe top with its gap above the keyboard", () => {
  const rows = 2 * searchPanel.rowPitch;
  expect(heightFor("aboveKeyboard", { rowsHeight: rows })).toBe(searchPanelFieldBlock(fieldHeight) + rows);
  expect(heightFor("aboveKeyboard", { rowsHeight: 9 * searchPanel.rowPitch })).toBe(fullPanel);
  const short = 560;
  const clearance = searchPanelPlace("aboveKeyboard", resting, false).gapAboveKeyboard;
  expect(clearance).toBeGreaterThan(0);
  expect(heightFor("aboveKeyboard", { rowsHeight: 9 * searchPanel.rowPitch, windowHeight: short })).toBe(short - safeTop - resting - clearance);
  expect(heightFor("aboveKeyboard", { windowHeight: safeTop + resting })).toBe(0);
});
