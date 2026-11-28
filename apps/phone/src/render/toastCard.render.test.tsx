import { StyleSheet } from "react-native";
import { act } from "react-test-renderer";
import { ToastHost } from "../components/toasts/ToastHost";
import { toastTileInk } from "../components/toasts/toastTokens";
import { chromeLayout, DesignProvider, rolesFor, space, surfaceInkFor, toastLayout } from "../components/ui";
import { rolesFromScheme } from "../components/ui/materialRoles";
import { materialBottomBar } from "../components/ui/materialTokens";
import { SEEDED_SCHEMES } from "../lib/material/schemes";
import { compositeOver, inkChannels, luminanceContrast, plateLuminance, READABLE_GLYPH, READABLE_TEXT } from "../lib/readableInk";
import { useBrowse } from "../state/browse/store";
import { notePageBar, showToast, useToasts } from "../state/toasts/store";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

const SAFE_BOTTOM = 24;

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
  useToasts.setState({ toast: null, barTopY: null, pageBar: "full" });
});

afterEach(() => {
  act(() => useToasts.setState({ toast: null, pageBar: "full" }));
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

const luminance = (color: string) => {
  const [red, green, blue] = inkChannels(color);
  return plateLuminance(red, green, blue);
};

const contrastOn = (ink: string, under: string) => luminanceContrast(luminance(compositeOver(ink, under)), luminance(under));

const PAGES = ["#FFFFFF", "#000000", "#808080"];

const SHADES = [
  { name: "Glass and Classic light", fill: rolesFor(false).toastFill, ink: surfaceInkFor(false).roles },
  { name: "Glass and Classic dark", fill: rolesFor(true).toastFill, ink: surfaceInkFor(true).roles },
  { name: "Material You light", fill: rolesFromScheme(SEEDED_SCHEMES.ardia.light, false).toastFill, ink: rolesFromScheme(SEEDED_SCHEMES.ardia.light, false) },
  { name: "Material You dark", fill: rolesFromScheme(SEEDED_SCHEMES.ardia.dark, true).toastFill, ink: rolesFromScheme(SEEDED_SCHEMES.ardia.dark, true) },
];

test.each(SHADES)("$name: the near-opaque card keeps its title, detail and button at 4.5:1 and its glyphs at 3:1 over any page", ({ fill, ink }) => {
  expect(inkChannels(fill)[3]).toBeGreaterThanOrEqual(0.97);
  for (const page of PAGES) {
    const card = compositeOver(fill, page);
    expect(contrastOn(ink.toastLabel, card)).toBeGreaterThanOrEqual(READABLE_TEXT);
    expect(contrastOn(ink.toastDetail, card)).toBeGreaterThanOrEqual(READABLE_TEXT);
    expect(contrastOn(card, compositeOver(ink.toastLabel, card))).toBeGreaterThanOrEqual(READABLE_TEXT);
    const dark = luminance(card) < 0.18;
    const tile = compositeOver(dark ? toastTileInk.neutral.dark : toastTileInk.neutral.light, card);
    expect(contrastOn(ink.toastLabel, tile)).toBeGreaterThanOrEqual(READABLE_GLYPH);
  }
});

const plateOf = (root: ReturnType<typeof renderSurface>) => root.root.findAll((node) => node.props.testID === "toastPlate" && typeof node.type === "string")[0]!;
const placeOf = (root: ReturnType<typeof renderSurface>) => StyleSheet.flatten(root.root.findAll((node) => node.props.testID === "toastPlace" && typeof node.type === "string")[0]!.props.style);
const textColor = (root: ReturnType<typeof renderSurface>, testID: string) => StyleSheet.flatten(root.root.findAll((node) => node.props.testID === testID && typeof node.type === "string")[0]!.props.style).color as string;

test("the card's ink is the plate's own shade, so the plate-ink check holds, and its title and detail read on the drawn fill", () => {
  const root = renderSurface(<ToastHost />);
  act(() => showToast({ title: "Cleared Browsing Data", detail: "History · Last Hour", icon: "checkmark" }));
  const fill = StyleSheet.flatten(plateOf(root).props.style).backgroundColor as string;
  for (const page of PAGES) {
    expect(contrastOn(textColor(root, "toastTitle"), compositeOver(fill, page))).toBeGreaterThanOrEqual(READABLE_TEXT);
    expect(contrastOn(textColor(root, "toastDetail"), compositeOver(fill, page))).toBeGreaterThanOrEqual(READABLE_TEXT);
  }
  unmount(root);
});

test("the card spans the bar: its edges sit at the bar's side inset in the floating design and at Material You's bar edge", () => {
  const floating = renderSurface(
    <DesignProvider design="redesigned">
      <ToastHost />
    </DesignProvider>,
  );
  act(() => showToast("Copied Link", "link"));
  expect(placeOf(floating)).toMatchObject({ left: chromeLayout.barSideInset, right: chromeLayout.barSideInset, alignItems: "stretch" });
  unmount(floating);
  act(() => useToasts.setState({ toast: null }));
  const material = renderSurface(
    <DesignProvider design="material">
      <ToastHost />
    </DesignProvider>,
  );
  act(() => showToast("Copied Link", "link"));
  expect(placeOf(material)).toMatchObject({ left: materialBottomBar.edge, right: materialBottomBar.edge });
  unmount(material);
});

test("an update with the same key keeps the same card on screen: no remount, no new entrance, only the text changes", () => {
  const root = renderSurface(<ToastHost />);
  act(() => showToast({ key: "download:1", title: "otter.pdf", detail: "Downloading · 10%", tile: { kind: "file", ext: "pdf" }, progress: 0.1, stage: "downloading" }));
  const plate = plateOf(root);
  act(() => showToast({ key: "download:1", title: "otter.pdf", detail: "Downloaded · 1.2 MB", tile: { kind: "file", ext: "pdf" }, stage: "done", action: { label: "Open", run: () => undefined } }));
  expect(plateOf(root)).toBe(plate);
  expect(root.root.findAll((node) => node.props.testID === "toastDetail" && typeof node.type === "string")[0]!.props.children).toBe("Downloaded · 1.2 MB");
  expect(root.root.findAll((node) => node.props.testID === "toastProgress")).toHaveLength(0);
  unmount(root);
});

test("a file name truncates in the middle on one line, and a failure headline may take two", () => {
  const root = renderSurface(<ToastHost />);
  const title = () => root.root.findAll((node) => node.props.testID === "toastTitle" && typeof node.type === "string")[0]!.props;
  act(() => showToast({ title: "a-very-long-quarterly-report-name-2026.pdf", tile: { kind: "file", ext: "pdf" } }));
  expect(title()).toMatchObject({ numberOfLines: 1, ellipsizeMode: "middle" });
  act(() => showToast({ title: "Couldn’t download a-very-long-quarterly-report-name-2026.pdf", tile: { kind: "icon", icon: "warning" }, titleLines: 2 }));
  expect(title()).toMatchObject({ numberOfLines: 2, ellipsizeMode: "tail" });
  unmount(root);
});

test("over a page the card sits one gap above whichever bar shows: the full bar, the collapsed pill, or the safe area once the bar is gone", () => {
  act(() => useBrowse.setState({ surface: "browsing" }));
  const root = renderSurface(
    <DesignProvider design="material">
      <ToastHost />
    </DesignProvider>,
  );
  act(() => showToast("Copied Link", "link"));
  expect(placeOf(root).bottom).toBe(SAFE_BOTTOM + materialBottomBar.inset + materialBottomBar.height + space.s);
  act(() => notePageBar("pill"));
  expect(placeOf(root).bottom).toBe(SAFE_BOTTOM + materialBottomBar.inset + 36 + space.s);
  act(() => notePageBar("gone"));
  expect(placeOf(root).bottom).toBe(SAFE_BOTTOM + space.s);
  unmount(root);
});

test("with a full sheet in front the card sits one gap above the safe area, not where the hidden bar would be", () => {
  act(() => useBrowse.setState({ surface: "browsing" }));
  const root = renderSurface(<ToastHost covered />);
  act(() => showToast("Cleared Browsing Data", "checkmark"));
  expect(placeOf(root).bottom).toBe(SAFE_BOTTOM + space.s);
  unmount(root);
});

test("a card's tile and button follow the layout: a 26 point tile, one capsule, and a progress line only while it runs", () => {
  const root = renderSurface(<ToastHost />);
  act(() => showToast({ key: "d", title: "otter.pdf", detail: "Downloading…", tile: { kind: "file", ext: "pdf" }, progress: null, action: { label: "Cancel", quiet: true, run: () => undefined } }));
  const tile = StyleSheet.flatten(root.root.findAll((node) => node.props.testID === "toastTile" && typeof node.type === "string")[0]!.props.style);
  expect([tile.width, tile.height, tile.backgroundColor]).toEqual([toastLayout.tile, toastLayout.tile, toastTileInk.file.pdf]);
  expect(root.root.findAll((node) => node.props.testID === "toastAction" && typeof node.type === "string")).toHaveLength(1);
  expect(root.root.findAll((node) => node.props.testID === "toastProgress" && typeof node.type === "string")).toHaveLength(1);
  const card = root.root.findAll((node) => node.props.testID === "toast" && typeof node.type === "string")[0]!;
  expect(card.props.accessibilityActions).toEqual([{ name: "dismiss", label: "Close" }, { name: "activate" }]);
  unmount(root);
});
