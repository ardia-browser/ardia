import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { mount } from "../../test-hooks.mjs";
const { usePanelsPresence } = await import("../ui/Popover.tsx");

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
  assert.match(overlays, /\{verificationCodes && <VerificationCodeOffer /, "a pane watches for a verification code only while a plugin that sets them up is on");
  const prompts = readFileSync(new URL("../site/Prompts.tsx", import.meta.url), "utf8");
  assert.match(prompts, /return offered \? <VerificationCodePrompt \{\.\.\.props\} \/> : null;/, "the verification code prompt mounts only while a code is offered");
  const pane = readFileSync(new URL("./TabPane.tsx", import.meta.url), "utf8");
  assert.ok(!pane.includes("TabContentArea"), "the content area is marked by a prop, not a wrapper component per pane");
});
