import assert from "node:assert/strict";
import { test } from "node:test";
import { HIDDEN_TEXT_SELECTOR, elementText, ownText, type TextElementLike, type TextNodeLike } from "./elementText.ts";

interface FakeElement extends TextElementLike {
  parent: FakeElement | null;
  readonly childNodes: TextNodeLike[];
}

const text = (value: string): TextNodeLike => ({ nodeType: 3, textContent: value, childNodes: [] });

function el(tag: string, attrs: string[], ...children: (FakeElement | string)[]): FakeElement {
  const node: FakeElement = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    isContentEditable: attrs.includes("contenteditable"),
    parent: null,
    childNodes: children.map((c) => (typeof c === "string" ? text(c) : c)),
    get textContent() {
      return this.childNodes.map((c) => c.textContent ?? "").join("");
    },
    matches(selector: string) {
      return selector.split(",").some((part) => {
        const s = part.trim();
        if (s.startsWith(".")) return attrs.includes(`class:${s.slice(1)}`);
        if (s.startsWith("[") && s.endsWith("]")) return attrs.includes(s.slice(1, -1));
        return false;
      });
    },
    closest(selector: string) {
      for (let at: FakeElement | null = node; at; at = at.parent) if (at.matches(selector)) return at;
      return null;
    },
  };
  for (const child of children) if (typeof child !== "string") child.parent = node;
  return node;
}

function donorSection() {
  const list = el("ul", ["data-private", "data-ac-no-capture"], el("li", [], "Ada Lovelace"), el("li", [], "Northwind Labs"));
  const wrapper = el("div", ["class:donors"], el("p", ["class:label"], "Monthly sponsors"), list, el("p", [], "This spot is saving a seat for your name."));
  return { wrapper, list, pill: list.childNodes[0] as FakeElement };
}

test("the hidden-text selector covers private and no-capture markers", () => {
  for (const marker of ["[data-private]", ".ac-private", ".ph-sensitive", "[data-ac-no-capture]", ".ph-no-capture"]) {
    assert.ok(HIDDEN_TEXT_SELECTOR.split(",").map((s) => s.trim()).includes(marker), marker);
  }
});

test("a click on a wrapper never collects text from its private or no-capture children", () => {
  const { wrapper } = donorSection();
  const collected = elementText(wrapper);
  assert.equal(collected, "Monthly sponsors This spot is saving a seat for your name.");
  for (const name of ["Ada Lovelace", "Northwind Labs"]) assert.ok(!collected.includes(name), name);
});

test("text inside a private or no-capture element is never collected, from itself or its children", () => {
  const { list, pill } = donorSection();
  assert.equal(elementText(list), "");
  assert.equal(elementText(pill), "");
  assert.equal(ownText(pill), "");
  const onlyNoCapture = el("div", ["class:ph-no-capture"], el("span", [], "Secret"));
  assert.equal(elementText(onlyNoCapture), "");
  const deep = el("section", [], el("div", [], el("span", ["class:ac-private"], el("b", [], "Hidden")), " shown"));
  assert.equal(elementText(deep), "shown");
});

test("fields and contenteditable children don't leak their text into a wrapper", () => {
  const wrapper = el("form", [], el("label", [], "Note"), el("textarea", [], "typed secret"), el("div", ["contenteditable"], "draft text"));
  assert.equal(elementText(wrapper), "Note");
});

test("ordinary text still comes through, trimmed and capped", () => {
  const button = el("button", [], "  Become   a sponsor ");
  assert.equal(ownText(button), "Become a sponsor");
  assert.equal(elementText(el("div", [], el("span", [], "x".repeat(400)))).length, 255);
  assert.equal(elementText(el("div", [], el("span", [], "4111 1111 1111 1111"))), "");
});

test("a number split across elements is still caught as sensitive", () => {
  assert.equal(elementText(el("div", [], el("span", [], "123-"), el("span", [], "45-6789"))), "");
  assert.equal(elementText(el("p", [], el("b", [], "4111 1111"), el("i", [], " 1111 1111"))), "");
  assert.equal(ownText(el("p", [], "123-", el("br", []), "45-6789")), "");
  assert.equal(elementText(el("div", [], el("span", [], "Plan"), el("span", [], "Monthly"))), "Plan Monthly");
});
