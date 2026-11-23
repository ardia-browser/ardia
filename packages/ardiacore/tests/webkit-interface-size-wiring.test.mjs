import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const path = (name) => fileURLToPath(new URL(name, import.meta.url));
const sources = ["../ios/WebKitTab.swift", "../ios/WebKitTab+PageTab.swift", "../ios/WebKitPageContainer.swift", "../ios/WebKitWebView.swift"];
const read = (name) => (existsSync(path(name)) ? readFileSync(path(name), "utf8") : "");
const tab = read("../ios/WebKitTab.swift");
const pageTab = read("../ios/WebKitTab+PageTab.swift");
const container = read("../ios/WebKitPageContainer.swift");
const webView = read("../ios/WebKitWebView.swift");

const body = (source, header, closer = "\n  }\n") => {
  const start = source.indexOf(header);
  if (start < 0) return "";
  const end = source.indexOf(closer, start);
  return source.slice(start, end < 0 ? source.length : end);
};

test("every source the checks read exists", () => {
  const missing = sources.filter((name) => !existsSync(path(name)));
  assert.deepEqual(missing, []);
});

test("a WebKit page sits in an unscaled container, so its resize mask never meets the tab's scaled bounds and still works in WebKit's fullscreen window", () => {
  const attach = body(tab, "func attach(_ view: WebKitWebView) {");
  assert.ok(attach.includes("pageContainer.hold(view)"), "attach puts the page in the container");
  assert.ok(!/addSubview\(view\)/.test(tab), "the page is never the tab's own subview");
  assert.ok(!/autoresizingMask/.test(tab + pageTab), "the tab puts no mask on the container or the page");
  assert.match(body(container, "func hold(_ page: NSView) {"), /page\.autoresizingMask = \[\.width, \.height\]/);
});

test("the tab sizes the container on every resize and layout, and never the page WebKit may have moved to fullscreen", () => {
  assert.match(body(tab, "override func resizeSubviews(withOldSize oldSize: NSSize)", "\n"), /fillWithPage\(\)/);
  assert.match(body(tab, "override func layout() {"), /fillWithPage\(\)/);
  assert.match(body(tab, "override func setFrameSize(_ newSize: NSSize) {"), /fitPageToInterfaceScale\(\)/);
  const fit = body(pageTab, "func fitPageToInterfaceScale() {");
  assert.ok(fit.indexOf("InterfaceScale.fitPageHost(self)") >= 0 && fit.indexOf("fillWithPage()") > fit.indexOf("InterfaceScale.fitPageHost(self)"), "the page is refilled after the tab's bounds take the scale");
  assert.match(body(pageTab, "func fillWithPage() {"), /pageContainer\.fill\(self\)/);
  assert.ok(!/(?<![.\w])(webView|view)\??\.frame =(?!=)/.test(tab + pageTab), "the tab never sets the page's frame");
});

test("the page finds its tab through the container, and finds none while it is in WebKit's fullscreen window", () => {
  assert.ok(webView.includes("private var page: WebKitTab? { (superview as? WebKitPageContainer)?.superview as? WebKitTab }"));
});
