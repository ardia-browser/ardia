import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const script = readFileSync(new URL("../../../../packages/ardiacore/ios/page_script.js", import.meta.url), "utf8");
const start = script.indexOf("  const placePip = ");
const end = script.indexOf("  const hidePip = ", start);
assert.ok(start > 0 && end > start, "page_script.js has placePip");
const source = script.slice(start, end);
const size = 32;

function buttonOn(box, viewport = { width: 1200, height: 800 }) {
  const pipHost = { style: {} };
  let hidden = false;
  const pipVideo = { isConnected: true, getBoundingClientRect: () => ({ ...box, right: box.left + box.width, bottom: box.top + box.height }) };
  new Function("pipHost", "pipVideo", "hidePip", "PIP_SIZE", "innerWidth", "innerHeight", `${source}placePip();`)(
    pipHost,
    pipVideo,
    () => (hidden = true),
    size,
    viewport.width,
    viewport.height,
  );
  if (hidden) return null;
  const left = parseFloat(pipHost.style.left);
  const top = parseFloat(pipHost.style.top);
  return { left, top, right: left + size, centerY: top + size / 2 };
}

test("the button sits inside the video's right edge, a little below its middle", () => {
  const box = { left: 100, top: 100, width: 640, height: 360 };
  const b = buttonOn(box);
  assert.equal(b.right, box.left + box.width - 12.8);
  assert.ok(b.centerY > box.top + box.height / 2 && b.centerY < box.top + box.height * 0.7);
});

test("a video taller than the window places the button on the part you can see", () => {
  const b = buttonOn({ left: 0, top: -400, width: 1200, height: 1600 }, { width: 1200, height: 800 });
  assert.ok(b.top > 0 && b.top + size < 800);
  assert.equal(b.right, 1200 - 16);
});

test("a video scrolled almost out of view hides the button", () => {
  assert.equal(buttonOn({ left: 0, top: -340, width: 640, height: 360 }), null);
});

test("a partly visible video too narrow on screen for the button hides it", () => {
  assert.equal(buttonOn({ left: 1180, top: 100, width: 640, height: 360 }, { width: 1200, height: 800 }), null);
});

const between = (from, to) => {
  const a = script.indexOf(from);
  const b = script.indexOf(to, a);
  assert.ok(a > 0 && b > a, `page_script.js has ${from}`);
  return script.slice(a, b);
};

const linkRules = between("  const pageAddress = ", "  const pipFits = ");
const insideLinkOn = (here) => new Function("location", `${linkRules}return insideLink;`)({ href: here });
const node = (anchor, host) => ({ closest: () => anchor, getRootNode: () => ({ host }) });

test("a video in a link to another page counts as a thumbnail preview", () => {
  const insideLink = insideLinkOn("https://www.youtube.com/results?search_query=cats");
  assert.equal(insideLink(node({ href: "https://www.youtube.com/watch?v=abc" })), true);
});

test("a link to the page you're on, a javascript: link or no link doesn't count", () => {
  const insideLink = insideLinkOn("https://9gag.com/gag/amWN17j#comments");
  assert.equal(insideLink(node({ href: "https://9gag.com/gag/amWN17j" })), false);
  assert.equal(insideLink(node({ href: "javascript:void(0)" })), false);
  assert.equal(insideLink(node(null)), false);
});

test("a link around the shadow host of a player counts too", () => {
  const insideLink = insideLinkOn("https://example.com/");
  const host = node({ href: "https://example.com/post/1" });
  assert.equal(insideLink(node(null, host)), true);
});

test("a video inside an open shadow root under the pointer is found", () => {
  const search = between("  const videoUnder = ", "  const shadowVideoAtMostEvery = ");
  const shadowVideoAt = new Function("pipFits", `${search}return shadowVideoAt;`)(() => true);
  const video = { getBoundingClientRect: () => ({ left: 0, top: 0, right: 400, bottom: 300 }) };
  const player = { shadowRoot: { querySelectorAll: () => [video], elementsFromPoint: () => [] } };
  const document = { elementsFromPoint: () => [{ shadowRoot: null }, player] };
  assert.equal(shadowVideoAt(document, 100, 100, new Set()), video);
  assert.equal(shadowVideoAt(document, 500, 100, new Set()), null);
});

test("the button is built without HTML strings, so Trusted Types pages like YouTube get it", () => {
  assert.doesNotMatch(between("  const PIP_SIZE = ", "  handlers.pipButton = "), /innerHTML|outerHTML|insertAdjacentHTML/);
});
