import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mount } from "../../../test-hooks.mjs";
globalThis.require ??= (id) => ({ asset: id });
await import("../../../test-native/index.ts");
const { animations } = await import("react-native");
const { usePresence } = await import("../../ui/motion.ts");
const { useTour } = await import("../../../state/onboarding/tour.ts");
const { WindowContext } = await import("../../../state/browser/hooks.ts");
const { ToolTour } = await import("./ToolTour.tsx");

const FADE = { show: { duration: 250, easing: (t) => t }, hide: { duration: 150, easing: (t) => t } };
after(() => {
  animations.held = false;
  useTour.setState({ windowId: null, stops: [], index: 0, session: 0 });
});

test("a presence that mounts already showing fades in when asked to, and shows at once otherwise", () => {
  animations.held = true;
  const entering = mount(() => usePresence("tour", FADE, true));
  assert.equal(entering.value.shown, "tour");
  assert.equal(entering.value.appear.value, 0, "starts hidden");
  assert.equal(animations.running.length, 1, "and runs its entrance");
  animations.finish();
  assert.equal(entering.value.appear.value, 1);
  entering.unmount();

  const plain = mount(() => usePresence("tour", FADE));
  assert.equal(plain.value.appear.value, 1, "the default keeps a presence that mounts showing at full opacity");
  assert.equal(animations.running.length, 0);
  plain.unmount();
  animations.held = false;
});

test("the Tool Tour mounted with its tour already active, as the window's gate mounts it, fades in", () => {
  animations.held = true;
  useTour.setState({ windowId: "w", stops: [{ anchor: "sidebar", title: "Sidebar", body: "" }], index: 0, session: 1 });
  const tour = mount(() => ToolTour(), { contexts: [[WindowContext, "w"]] });
  const opacity = tour.value.props.style[1].opacity;
  assert.equal(opacity.value, 0);
  assert.equal(animations.running.some((r) => r.value === opacity && r.to === 1), true);
  animations.finish();
  assert.equal(opacity.value, 1);
  tour.unmount();
  animations.held = false;
});
