import vm from "node:vm";
import { translatorCall } from "../pageTranslator.ts";

export class FakeNode {
  parentNode = null;
  childNodes = [];
  get parentElement() {
    return this.parentNode?.nodeType === 1 ? this.parentNode : null;
  }
  get isConnected() {
    let node = this;
    while (node.parentNode) node = node.parentNode;
    return node.isRoot === true;
  }
}
export class FakeText extends FakeNode {
  nodeType = 3;
  constructor(value) {
    super();
    this.nodeValue = value;
  }
}
export class FakeElement extends FakeNode {
  nodeType = 1;
  constructor(tag, children = []) {
    super();
    this.tagName = tag.toUpperCase();
    for (const child of children) {
      child.parentNode = this;
      this.childNodes.push(child);
    }
  }
  closest(selector) {
    const tags = selector.split(",").map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z0-9]+$/.test(s));
    for (let node = this; node && node.nodeType === 1; node = node.parentNode) if (tags.includes(node.tagName)) return node;
    return null;
  }
  getBoundingClientRect() {
    return { top: 0, bottom: 20, left: 0, right: 100, width: 100, height: 20 };
  }
}

export function fakePage(body, { whiteSpace = "normal" } = {}) {
  const html = new FakeElement("html", [body]);
  html.isRoot = true;
  const descendants = (root) => root.childNodes.flatMap((child) => [child, ...descendants(child)]);
  const results = [];
  const context = {
    NodeFilter: { SHOW_ELEMENT: 1, SHOW_TEXT: 4 },
    innerHeight: 800,
    innerWidth: 1200,
    getComputedStyle: (el) => ({ whiteSpace: el.whiteSpace ?? whiteSpace }),
    IntersectionObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    document: {
      body,
      documentElement: html,
      createTreeWalker(root, show) {
        const nodes = descendants(root).filter((n) => (n.nodeType === 3 ? show & 4 : show & 1));
        let i = 0;
        return { nextNode: () => nodes[i++] ?? null };
      },
    },
    post: (_kind, json) => results.push(JSON.parse(json)),
  };
  context.window = context;
  vm.createContext(context);
  const call = (op, ...args) => {
    vm.runInContext(`{\n${translatorCall(op, ...args)}\n}`, context);
    return results.pop();
  };
  const run = (code) => {
    vm.runInContext(`{\n${code}\n}`, context);
    return results.pop();
  };
  return { call, run };
}
