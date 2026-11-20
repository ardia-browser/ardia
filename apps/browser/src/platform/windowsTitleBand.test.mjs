import assert from "node:assert/strict";
import { test } from "node:test";
import { claimsTitleBandPress, pressOnTextField } from "../../../../packages/expo-windows/src/titleBandPress.ts";
import { windowsTitleBand } from "../../../../packages/expo-windows/src/titleBandCounts.ts";

const HOST = 5;
const FUNCTION_COMPONENT = 0;

const fiber = (tag, type, parent) => ({ tag, type, return: parent, memoizedProps: {}, stateNode: null });

function pathTo(...hostTypes) {
  let deepest = null;
  for (const type of hostTypes) deepest = fiber(HOST, type, deepest && fiber(FUNCTION_COMPONENT, () => null, deepest));
  return { __internalInstanceHandle: deepest };
}

const press = (pageY, target) => ({ target, nativeEvent: { pageX: 300, pageY } });

test("the title band leaves a press on a text field to the field, so dragging across it selects text instead of moving the window (#2799)", () => {
  windowsTitleBand.takePresses();
  const field = pathTo("RCTView", "RCTView", "WindowsTextInput");
  assert.equal(pressOnTextField(press(21, field)), true);
  assert.equal(claimsTitleBandPress(press(21, field)), false);
  assert.equal(claimsTitleBandPress(press(21, pathTo("RCTView", "RCTView"))), true, "an empty part of the band still drags the window");
  assert.equal(claimsTitleBandPress(press(21, undefined)), true, "a press with no target the band can read still drags");
  assert.equal(claimsTitleBandPress(press(60, field)), false, "below the band nothing is claimed");
  assert.equal(claimsTitleBandPress(press(60, pathTo("RCTView"))), false);
  assert.deepEqual(windowsTitleBand.takePresses(), { taken: 2, leftToText: 1 }, "presses below the band are not counted");
  assert.deepEqual(windowsTitleBand.takePresses(), { taken: 0, leftToText: 0 });
});

test("a press inside a view nested in a text field is still the field's", () => {
  assert.equal(pressOnTextField(press(10, pathTo("RCTView", "RCTSinglelineTextInputView", "RCTView"))), true);
  assert.equal(pressOnTextField(press(10, pathTo("RCTView", "RCTText"))), false);
});
