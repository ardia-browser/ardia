import assert from "node:assert/strict";
import { test } from "node:test";
const { HoverFill } = await import("./HoverFill.tsx");
const { Symbol: ThemedSymbol } = await import("./Symbol.tsx");

test("the hover fill and the themed symbol skip a render when their parent re-renders with the same props", () => {
  for (const component of [HoverFill, ThemedSymbol]) assert.equal(component.$$typeof, Symbol.for("react.memo"));
});
