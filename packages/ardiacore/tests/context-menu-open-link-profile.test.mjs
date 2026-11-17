import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const menu = readFileSync(
  new URL("../../../engine/ardiacore/src/ardia/core/ac_context_menu.mm", import.meta.url),
  "utf8",
);
const between = (text, start, end) => {
  const from = text.indexOf(start);
  assert.ok(from >= 0, `${start} not found`);
  const to = text.indexOf(end, from + start.length);
  assert.ok(to >= 0, `${end} not found after ${start}`);
  return text.slice(from, to);
};

test("one helper removes Chrome's \"Open Link as\" submenu and each single-profile item", () => {
  const helper = between(menu, "void RemoveOpenLinkInProfile(RenderViewContextMenuBase& menu) {", "\n}\n");
  assert.match(helper, /menu\.RemoveMenuItem\(IDC_CONTENT_CONTEXT_OPENLINKINPROFILE\);/);
  assert.match(
    helper,
    /for \(int i = 0; i < kOpenLinkInProfileItems; \+\+i\) \{\n {4}menu\.RemoveMenuItem\(IDC_OPEN_LINK_IN_PROFILE_FIRST \+ i\);\n {2}\}/,
  );
});

test("a tab's arranged menu starts by removing it", () => {
  const arrange = between(menu, "  void ArrangeLikeDia() {", "\n  }\n");
  assert.match(arrange, /^ {2}void ArrangeLikeDia\(\) \{\n {4}RemoveOpenLinkInProfile\(\*this\);/);
});

test("contents with no tab or no view keep Chrome's menu, minus the submenu", () => {
  const build = between(menu, "  std::unique_ptr<RenderViewContextMenuBase> BuildMenu(", "\n  }\n");
  const fallback = between(build, "if (!TabOf(contents_) || !view) {", "\n    }\n");
  const stock = fallback.indexOf("ChromeWebContentsViewDelegateViewsMac::BuildMenu(");
  const removal = fallback.indexOf("RemoveOpenLinkInProfile(*stock);");
  const handedBack = fallback.indexOf("return stock;");
  assert.ok(stock >= 0, "the fallback builds Chrome's own menu");
  assert.ok(removal > stock, "the submenu is removed from the menu Chrome built");
  assert.ok(handedBack > removal, "the menu is handed back after the removal");
  assert.equal(
    menu.split("ChromeWebContentsViewDelegateViewsMac::BuildMenu(").length - 1,
    1,
    "no other path hands out Chrome's menu untouched",
  );
});
