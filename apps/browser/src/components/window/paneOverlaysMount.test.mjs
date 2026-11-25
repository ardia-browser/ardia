import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { useState, useSyncExternalStore } from "react";
import { mount } from "../../test-hooks.mjs";
const { usePanelsPresence } = await import("../ui/Popover.tsx");
const { BEHIND_NEW_TAB, OVERLAY, nextShownOverlays, overlayBits, overlayCount, pageOverlays, useEligibleGate, useKeptOverlays, useKeptWhile, useShownOverlaysCount } = await import("./overlayGate.ts");
const { useBrowser } = await import("../../state/browser/store.ts");
const { makeTab } = await import("../../state/browser/model.ts");
const fakeTab = (id, url) => ({ ...makeTab("w", "personal", url), id });
const { useMedia } = await import("../../state/media/media.ts");
const { useShareFor } = await import("../../state/media/screenShare.ts");
const { patchPage } = await import("../../state/tabs/pageState.ts");
const { pageOf } = await import("../../state/tabs/pageState.ts");
const IDLE_PAGE = pageOf("no such tab");

const KINDS = ["siteControls", "zoom", "hiddenElements"];
const shownOf = (panel) => Object.fromEntries(KINDS.map((kind) => [kind, panel(kind)]).filter(([, presence]) => presence).map(([kind, presence]) => [kind, presence.closing ? "closing" : "open"]));

test("a pane shows no site panel until one opens, and a closing panel stays until its close animation ends", () => {
  const hook = mount(({ open }) => usePanelsPresence(open, KINDS), { props: { open: null } });
  assert.deepEqual(shownOf(hook.value), {});
  assert.deepEqual(shownOf(hook.rerender({ open: "popups" })), {}, "a popover that is not a site panel shows none");
  assert.deepEqual(shownOf(hook.rerender({ open: "zoom" })), { zoom: "open" });
  assert.deepEqual(shownOf(hook.rerender({ open: "siteControls" })), { zoom: "closing", siteControls: "open" });
  hook.value("zoom").onClosed();
  assert.deepEqual(shownOf(hook.value), { siteControls: "open" });
  assert.deepEqual(shownOf(hook.rerender({ open: null })), { siteControls: "closing" });
  assert.deepEqual(shownOf(hook.rerender({ open: "siteControls" })), { siteControls: "open" }, "reopening before the close ends keeps the same panel");
  hook.rerender({ open: null });
  hook.value("siteControls").onClosed();
  assert.deepEqual(shownOf(hook.value), {});
});

test("each pane mounts its rare overlays only while they show, with no wrapper component per pane", () => {
  const overlays = readFileSync(new URL("./PageOverlays.tsx", import.meta.url), "utf8");
  for (const wrapper of ["<SiteControls ", "<ZoomPopover", "<HiddenElementsPopover"]) assert.ok(!overlays.includes(wrapper), `${wrapper} is a per-pane wrapper`);
  assert.match(overlays, /\{verificationCodes && has\("verificationCode"\) && <VerificationCodePrompt /, "a pane mounts the verification code prompt only while a plugin that sets them up is on and a code is offered");
  const pane = readFileSync(new URL("./TabPane.tsx", import.meta.url), "utf8");
  assert.ok(!pane.includes("TabContentArea"), "the content area is marked by a prop, not a wrapper component per pane");
});

test("a pane shown with nothing over its page mounts none of its overlays, only the swipe area", () => {
  const overlays = readFileSync(new URL("./PageOverlays.tsx", import.meta.url), "utf8");
  const body = overlays.slice(overlays.indexOf("export function PageOverlays("), overlays.indexOf("function usePageOverlays("));
  const jsx = body.slice(body.indexOf("return ("));
  const ungated = jsx.split("\n").filter((line) => /^ {6}<[A-Z]/.test(line)).map((line) => line.trim().split(/[ />]/)[0]);
  assert.deepEqual(ungated, ["<SwipeOverlay"], "every other overlay waits for its state");
  for (const overlay of Object.keys(OVERLAY).filter((o) => o !== "control")) assert.ok(jsx.includes(`has("${overlay}")`), `${overlay} is gated`);
  assert.match(jsx, /\{cliPill && control\.mounted && <ControlPill /);
  assert.match(body, /const lasting = useLastingLoad\(tabId, loadingPill && !newTabShown\);/, "the pill mounts only once a load has lasted, so a quick load mounts nothing");
  assert.match(jsx, /<LoadingPill loading=\{lasting\} \/>/);
  const pill = readFileSync(new URL("./LoadingPill.tsx", import.meta.url), "utf8");
  assert.ok(!pill.includes("useLastingLoad("), "the lasting check runs once, in the gate");
  const pane = readFileSync(new URL("./TabPane.tsx", import.meta.url), "utf8");
  assert.match(pane, /const share = useShareFor\(tabId, shareBarRoom\);\n  const shareBar = useKeptWhile\(!!share, shareBarRoom\);/);
  assert.match(pane, /\{shareBar && <ShareBar tabId=\{tabId\} found=\{share\} \/>\}/);
  assert.match(pane, /\{visible && own\.appPage && <InternalPage /);
});

test("each page state that shows an overlay turns on its own bit", () => {
  assert.equal(pageOverlays(IDLE_PAGE), 0);
  const cases = { status: { status: "https://a.test/" }, sadTab: { crashed: { reason: "crashed" } }, permission: { permission: { id: 1 } }, password: { passwordPrompt: {} }, autofill: { autofillPrompt: {} }, verificationCode: { verificationCode: {} }, externalApp: { externalApp: {} } };
  for (const [overlay, patch] of Object.entries(cases)) assert.equal(pageOverlays({ ...IDLE_PAGE, ...patch }), OVERLAY[overlay], overlay);
  assert.equal(pageOverlays({ ...IDLE_PAGE, unresponsive: true }), OVERLAY.sadTab);
  assert.equal(overlayBits({ find: true, selection: false, loading: true }), OVERLAY.find | OVERLAY.loading);
  assert.equal(overlayCount(OVERLAY.find | OVERLAY.loading | OVERLAY.control), 3);
});

test("an overlay stays mounted once it showed, so its close animation runs, and only one that turned on later animates in", () => {
  const hook = mount(({ on }) => useKeptOverlays(on, on), { props: { on: OVERLAY.status } });
  assert.equal(hook.value.has("status"), true);
  assert.equal(hook.value.has("find"), false);
  assert.equal(hook.value.entersLater("status"), false, "a link address already showing when the tab came into view shows at once, as before");
  hook.rerender({ on: OVERLAY.find });
  assert.equal(hook.value.has("find"), true);
  assert.equal(hook.value.has("status"), true, "the link address stays mounted to fade out");
  assert.equal(hook.value.entersLater("find"), true);
  hook.rerender({ on: 0 });
  assert.equal(hook.value.has("find") && hook.value.has("status"), true);
});

test("the share bar stays mounted while the pane shows, and is let go when it hides", () => {
  const hook = mount(({ on, alive }) => useKeptWhile(on, alive), { props: { on: false, alive: true } });
  assert.equal(hook.value, false);
  assert.equal(hook.rerender({ on: true, alive: true }), true);
  assert.equal(hook.rerender({ on: false, alive: true }), true);
  assert.equal(hook.rerender({ on: false, alive: false }), false);
  assert.equal(hook.rerender({ on: false, alive: true }), false);
});

test("the CLI pill shows at once when an active indicator gains an eligible pane, and fades in only when it turns on in one", () => {
  const gate = mount(({ on, eligible }) => useEligibleGate(on, eligible), { props: { on: false, eligible: true } });
  assert.deepEqual(gate.value, { mounted: false, enter: false });
  assert.deepEqual(gate.rerender({ on: true, eligible: true }), { mounted: true, enter: true }, "turned on in a pane that showed it: fades in");
  assert.deepEqual(gate.rerender({ on: true, eligible: false }), { mounted: false, enter: false }, "focus moved to the other split pane");
  assert.deepEqual(gate.rerender({ on: true, eligible: true }), { mounted: true, enter: false }, "focus back, or Peek closed, with the indicator on: shown at once, as before");
  assert.deepEqual(gate.rerender({ on: false, eligible: true }), { mounted: true, enter: false }, "stays mounted to fade out");
  const fresh = mount(({ on, eligible }) => useEligibleGate(on, eligible), { props: { on: true, eligible: true } });
  assert.deepEqual(fresh.value, { mounted: true, enter: false }, "a tab coming into view with the indicator on shows it at once");
});

test("overlay telemetry counts each time one becomes visible, not each mount, and never one held behind the New Tab page", () => {
  let state = nextShownOverlays(null, 0);
  assert.deepEqual([state.atShow, state.opened], [0, 0]);
  const opened = [];
  for (const shown of [OVERLAY.find, 0, OVERLAY.find, OVERLAY.find | OVERLAY.status]) {
    state = nextShownOverlays(state, shown);
    opened.push(state.opened);
  }
  assert.deepEqual(opened, [1, 0, 1, 1], "Find opened, closed and opened again in one visit counts twice");
  const newTabShown = true;
  const permission = OVERLAY.permission & ~(newTabShown ? BEHIND_NEW_TAB : 0);
  assert.equal(nextShownOverlays(nextShownOverlays(null, 0), permission).opened, 0, "a permission request behind the New Tab page isn't counted until its prompt shows");
  assert.equal(nextShownOverlays(null, OVERLAY.status | OVERLAY.find).atShow, 2);
  const overlays = readFileSync(new URL("./overlayGate.ts", import.meta.url), "utf8");
  assert.match(overlays, /const consent = consentToken\(\);\n  useEffect\(\(\) => \{/, "consent is taken in the render that shows the overlay, and counted only once it commits");
});

test("a pane finds a share to show only while it can show the bar, and not for a tab the share skips", () => {
  const profiles = { personal: { id: "personal", name: "Personal" } };
  useBrowser.setState({ profiles: { ...useBrowser.getState().profiles, ...profiles }, tabs: { ...useBrowser.getState().tabs, capturer: fakeTab("capturer", "https://meet.example/"), viewer: fakeTab("viewer", "https://news.example/"), internal: fakeTab("internal", "ardia://history") } });
  useMedia.setState({ tabShares: { capturer: { capturedTabId: "viewer", origin: "https://meet.example", dismissed: { dismissed: true } } } });
  patchPage("capturer", { mediaAccess: { camera: false, microphone: false, screen: true } });
  try {
    assert.equal(mount(() => useShareFor("viewer", true)).value?.[0], "capturer");
    assert.equal(mount(() => useShareFor("viewer", false)).value, null, "a hidden or full-screen pane finds none");
    assert.equal(mount(() => useShareFor("internal", true)).value, null, "an internal page shows no share bar");
    useBrowser.setState({ tabs: { ...useBrowser.getState().tabs, dismissed: fakeTab("dismissed", "https://x.example/") } });
    assert.equal(mount(() => useShareFor("dismissed", true)).value, null, "a tab whose bar was dismissed shows none");
  } finally {
    useMedia.setState({ tabShares: {} });
    patchPage("capturer", { mediaAccess: null });
  }
});

test("a render React throws away neither counts an overlay nor resets the CLI pill's gate", () => {
  const notes = [];
  const counter = mount(({ shown }) => useShownOverlaysCount(shown, (atShow, opened) => notes.push([atShow, opened])), { props: { shown: 0 } });
  counter.discard({ shown: OVERLAY.find });
  counter.rerender({ shown: OVERLAY.find });
  assert.deepEqual(notes, [[0, 1]], "one committed opening is one count");
  counter.discard({ shown: 0 });
  counter.rerender({ shown: OVERLAY.find });
  assert.deepEqual(notes, [[0, 1]], "a discarded close followed by the same mask counts nothing");

  const gate = mount(({ on, eligible }) => useEligibleGate(on, eligible), { props: { on: true, eligible: true } });
  gate.discard({ on: true, eligible: false });
  assert.deepEqual(gate.rerender({ on: false, eligible: true }), { mounted: true, enter: false }, "the pill stays mounted to fade out");

  const kept = mount(({ on }) => useKeptOverlays(on, on), { props: { on: 0 } });
  kept.discard({ on: OVERLAY.find });
  assert.equal(kept.rerender({ on: 0 }).has("find"), false, "an overlay only a discarded render saw isn't kept");

  const share = mount(({ on, alive }) => useKeptWhile(on, alive), { props: { on: true, alive: true } });
  share.discard({ on: false, alive: false });
  assert.equal(share.rerender({ on: false, alive: true }), true, "the share bar keeps its slide-out after a discarded hidden render");
});

test("the pane's visibility count leaves the selection search to its own bar", () => {
  const overlays = readFileSync(new URL("./PageOverlays.tsx", import.meta.url), "utf8");
  assert.match(overlays, /& ~OVERLAY\.selection/);
});

test("a discarded render subscribes to and unsubscribes from no store", () => {
  let subscribed = 0;
  let unsubscribed = 0;
  const storeOf = () => () => {
    subscribed++;
    return () => unsubscribed++;
  };
  const stores = { a: storeOf(), b: storeOf() };
  const hook = mount(({ key }) => useSyncExternalStore(stores[key], () => key), { props: { key: "a" } });
  assert.equal(hook.discard({ key: "b" }), "b", "it still reads the store");
  assert.deepEqual([subscribed, unsubscribed], [1, 0]);
  hook.rerender({ key: "b" });
  assert.deepEqual([subscribed, unsubscribed], [2, 1], "a committed render moves the subscription");
});

test("a state update made inside a discarded render doesn't survive it", () => {
  const hook = mount(({ see }) => {
    const [seen, setSeen] = useState(false);
    if (see && !seen) setSeen(true);
    return seen;
  }, { props: { see: false } });
  hook.discard({ see: true });
  assert.equal(hook.pending, false, "nothing is left to render");
  assert.equal(hook.rerender({ see: false }), false);
});
