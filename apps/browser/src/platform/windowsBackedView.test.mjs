import assert from "node:assert/strict";
import { test } from "node:test";

const { backgroundFill, FILL_Z_INDEX } = await import("../../../../packages/expo-windows/src/views/backgroundFill.ts");

const filled = (corners) => ({ position: "absolute", top: 0, bottom: 0, left: 0, right: 0, zIndex: FILL_Z_INDEX, backgroundColor: "red", ...corners });

test("no fill without a meaningful background, so the view is left as it is", () => {
  assert.equal(backgroundFill({}), null);
  assert.equal(backgroundFill({ backgroundColor: "transparent", borderRadius: 8 }), null);
});

test("the fill sits at the parent's padding box, since an absolute child's offsets already start inside the border", () => {
  assert.deepEqual(backgroundFill({ backgroundColor: "red", borderWidth: 2 }), filled({}));
});

test("each corner's inner radius loses only the borders that meet at that corner", () => {
  assert.deepEqual(backgroundFill({ backgroundColor: "red", borderRadius: 10 }), filled({ borderTopLeftRadius: 10, borderTopRightRadius: 10, borderBottomLeftRadius: 10, borderBottomRightRadius: 10 }));
  assert.deepEqual(backgroundFill({ backgroundColor: "red", borderRadius: 12, borderLeftWidth: 8 }), filled({ borderTopLeftRadius: 4, borderTopRightRadius: 12, borderBottomLeftRadius: 4, borderBottomRightRadius: 12 }));
  assert.deepEqual(backgroundFill({ backgroundColor: "red", borderWidth: 2, borderTopWidth: 3, borderRadius: 10, borderTopLeftRadius: 2 }), filled({ borderTopLeftRadius: 0, borderTopRightRadius: 7, borderBottomLeftRadius: 8, borderBottomRightRadius: 8 }));
  assert.equal(backgroundFill({ backgroundColor: "red", borderRadius: 10, borderStartWidth: 4 }).borderTopLeftRadius, 6);
});

test("a percentage radius passes through, and the fill sorts under children with a negative zIndex", () => {
  assert.equal(backgroundFill({ backgroundColor: "red", borderRadius: "50%" }).borderBottomRightRadius, "50%");
  assert.ok(backgroundFill({ backgroundColor: "red" }).zIndex < -1000000);
  assert.equal(backgroundFill({ backgroundColor: "red", borderCurve: "continuous" }).borderCurve, "continuous");
});
