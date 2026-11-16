import { PICKER_STYLE } from "./tokens";

const INSTALL = String.raw`
const KEY = Symbol.for("ardia.elementPicker");
if (!window[KEY]) {
  const LOOK = ${JSON.stringify(PICKER_STYLE)};
  const MAX_DEPTH = 12;
  const ATTRIBUTES = ["data-testid", "data-test-id", "data-test", "data-qa", "data-component", "data-module"];
  const STATE_CLASS = /^(?:is-|has-)?(?:active|hover|hovered|focus|focused|open|opened|selected|visible|show|shown|hidden|current|loaded|loading)$/i;
  const GENERATED = /^(?:css|sc|jsx|emotion|styled|svelte|tw|ember|ng-tns|_)[-_]?[a-z0-9]*\d/i;
  const esc = (s) => CSS.escape(s);
  const generated = (token) => !token || token.length > 40 || /\d{3,}/.test(token) || GENERATED.test(token) || (/\d/.test(token) && /[a-z]/i.test(token) && token.length >= 6 && !/[-_]/.test(token)) || /[^\w-]/.test(token);
  const stableId = (el) => !!el.id && !generated(el.id) && /^[A-Za-z]/.test(el.id);
  const matchesOnly = (selector, el) => {
    try {
      const found = document.querySelectorAll(selector);
      return found.length === 1 && found[0] === el;
    } catch (e) {
      return false;
    }
  };
  const classesOf = (el) =>
    [...el.classList]
      .filter((c) => !generated(c) && !STATE_CLASS.test(c))
      .map((c) => [c, document.getElementsByClassName(c).length])
      .sort((a, b) => a[1] - b[1])
      .map(([c]) => c);
  const segmentOf = (el, classes) => {
    let segment = esc(el.localName) + classes.map((c) => "." + esc(c)).join("");
    const parent = el.parentElement;
    if (!parent) return segment;
    const sameTag = [...parent.children].filter((c) => c.localName === el.localName);
    const alike = sameTag.filter((c) => c.matches(segment));
    if (alike.length > 1) segment += ":nth-of-type(" + (sameTag.indexOf(el) + 1) + ")";
    return segment;
  };
  const attributeOf = (el) => {
    for (const name of ATTRIBUTES) {
      const value = el.getAttribute(name);
      if (value && value.length <= 60 && !/[{}\n\r"\\]/.test(value)) return "[" + name + '="' + value + '"]';
    }
    return null;
  };
  const anchored = (parts) => parts.length > 1 || /[.#[]/.test(parts[0]);
  const selectorFor = (el) => {
    if (stableId(el) && matchesOnly("#" + esc(el.id), el)) return "#" + esc(el.id);
    const tag = esc(el.localName);
    const attribute = attributeOf(el);
    if (attribute && matchesOnly(tag + attribute, el)) return tag + attribute;
    const classes = classesOf(el);
    for (let n = 1; n <= Math.min(3, classes.length); n++) {
      const candidate = tag + classes.slice(0, n).map((c) => "." + esc(c)).join("");
      if (matchesOnly(candidate, el)) return candidate;
    }
    const parts = [];
    let node = el;
    for (let depth = 0; node && node !== document.documentElement && depth < MAX_DEPTH; depth++) {
      if (node !== el && stableId(node) && document.querySelectorAll("#" + esc(node.id)).length === 1) {
        parts.unshift("#" + esc(node.id));
        if (matchesOnly(parts.join(" > "), el)) break;
        parts.shift();
      }
      const own = node === el && attribute ? tag + attribute : null;
      parts.unshift(own || segmentOf(node, classesOf(node).slice(0, 2)));
      if (anchored(parts) && matchesOnly(parts.join(" > "), el)) break;
      node = node.parentElement;
    }
    let best = parts.join(" > ");
    for (let i = 1; i < parts.length; i++) {
      const shorter = parts.slice(i).join(" > ");
      if (anchored(parts.slice(i)) && matchesOnly(shorter, el)) best = shorter;
      else break;
    }
    return best;
  };
  const adopt = (sheet, on) => {
    const others = document.adoptedStyleSheets.filter((s) => s !== sheet);
    document.adoptedStyleSheets = on ? [...others, sheet] : others;
  };
  const hidingSheet = new CSSStyleSheet();
  const rules = new Set();
  const KEEP_MS = 1000;
  let keeper = 0;
  const ensure = () => {
    if (rules.size && !document.adoptedStyleSheets.includes(hidingSheet)) adopt(hidingSheet, true);
  };
  const writeRules = () => {
    hidingSheet.replaceSync([...rules].map((s) => s + " { display: none !important; }").join("\n"));
    adopt(hidingSheet, rules.size > 0);
    if (rules.size && !keeper) keeper = setInterval(ensure, KEEP_MS);
    if (!rules.size && keeper) keeper = clearInterval(keeper) || 0;
  };
  const pickable = (el) => !!el && el.nodeType === 1 && el !== document.documentElement && el !== document.body;

  const p = (window[KEY] = {
    session: null,
    ensure,
    apply(selectors) {
      for (const s of selectors) rules.add(s);
      writeRules();
      return true;
    },
    unhide(selectors) {
      for (const s of selectors) rules.delete(s);
      writeRules();
      for (const s of selectors) {
        try {
          for (const el of document.querySelectorAll(s)) if (el.style.getPropertyValue("display") === "none") el.style.removeProperty("display");
        } catch (e) {}
      }
      return true;
    },
    cancel() {
      if (p.session) p.session.finish({ cancelled: true });
      return true;
    },
    start(point) {
      if (p.session) p.session.finish({ cancelled: true });
      const focused = document.activeElement;
      if (focused && (focused.localName === "iframe" || focused.localName === "frame")) focused.blur();
      return new Promise((resolve) => {
        const host = document.createElement("ardia-element-picker");
        host.style.cssText = "all: initial !important; display: block !important; position: fixed !important; inset: 0 !important; pointer-events: none !important; z-index: 2147483647 !important;";
        const root = host.attachShadow({ mode: "closed" });
        const pickerSheet = new CSSStyleSheet();
        pickerSheet.replaceSync(
          "ardia-box{position:fixed;box-sizing:border-box;border:2px solid " + LOOK.outline + ";background:" + LOOK.fill + ";border-radius:4px;display:none;transition:" + ["left", "top", "width", "height"].map((p) => p + " " + LOOK.motionMs + "ms ease-out").join(",") + "}" +
          "ardia-tag{position:fixed;display:none;padding:2px 6px;border-radius:5px;background:" + LOOK.label + ";color:" + LOOK.labelText + ";font:600 11px/16px -apple-system,system-ui,sans-serif;white-space:nowrap;max-width:60vw;overflow:hidden;text-overflow:ellipsis}" +
          "ardia-hint{display:block !important;position:fixed;left:50%;bottom:20px;transform:translateX(-50%);padding:7px 14px;border-radius:999px;background:" + LOOK.hint + ";color:" + LOOK.hintText + ";font:500 12px/16px -apple-system,system-ui,sans-serif;white-space:nowrap;box-shadow:" + LOOK.hintShadow + "}" +
          "ardia-hint b{font-weight:600}"
        );
        root.adoptedStyleSheets = [pickerSheet];
        const part = (name) => root.appendChild(document.createElement(name));
        const box = part("ardia-box");
        const tag = part("ardia-tag");
        const hint = part("ardia-hint");
        for (const [bold, rest] of [["Click", " to hide · "], ["↑ ↓", " wider or narrower · "], ["Esc", " to cancel"]]) {
          hint.appendChild(document.createElement("b")).textContent = bold;
          hint.append(rest);
        }
        const cursor = new CSSStyleSheet();
        cursor.replaceSync("*, *::before, *::after { cursor: crosshair !important; }");
        let current = null;
        let narrower = [];
        const show = () => {
          const display = (el, value) => el.style.setProperty("display", value, "important");
          if (!current || !current.isConnected) {
            display(box, "none");
            display(tag, "none");
            return;
          }
          const r = current.getBoundingClientRect();
          display(box, "block");
          Object.assign(box.style, { left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
          const classes = classesOf(current).slice(0, 2).map((c) => "." + c).join("");
          tag.textContent = current.localName + classes + "  " + Math.round(r.width) + "×" + Math.round(r.height);
          display(tag, "block");
          const above = r.top >= 22;
          tag.style.left = Math.max(4, Math.min(r.left, innerWidth - 160)) + "px";
          tag.style.top = (above ? r.top - 20 : Math.min(innerHeight - 20, r.bottom + 4)) + "px";
        };
        const target = (x, y) => {
          const el = document.elementFromPoint(x, y);
          return pickable(el) ? el : null;
        };
        const block = (e) => {
          e.preventDefault();
          e.stopImmediatePropagation();
        };
        const onMove = (e) => {
          const el = target(e.clientX, e.clientY);
          if (narrower.length && current && el && current.contains(el)) return;
          if (el !== current) {
            current = el;
            narrower = [];
            show();
          }
        };
        const onClick = (e) => {
          block(e);
          if (e.button !== 0) return;
          const el = current || target(e.clientX, e.clientY);
          if (el) pick(el);
        };
        const onKey = (e) => {
          if (e.key === "Escape") {
            block(e);
            finish({ cancelled: true });
          } else if (e.key === "ArrowUp" && current) {
            block(e);
            const parent = current.parentElement;
            if (pickable(parent)) {
              narrower.push(current);
              current = parent;
              show();
            }
          } else if (e.key === "ArrowDown" && current) {
            block(e);
            const child = narrower.pop() || [...current.children].find((c) => c.getBoundingClientRect().width > 0);
            if (child) {
              current = child;
              show();
            }
          } else if (e.key === "Enter" && current) {
            block(e);
            pick(current);
          }
        };
        const onKeyUp = (e) => e.key === "Escape" && block(e);
        const onScroll = () => requestAnimationFrame(show);
        const pressEvents = ["mousedown", "mouseup", "pointerdown", "pointerup", "auxclick", "dblclick", "contextmenu", "touchstart", "touchend"];
        const listen = (on) => {
          const method = on ? "addEventListener" : "removeEventListener";
          window[method]("mousemove", onMove, true);
          window[method]("click", onClick, true);
          for (const name of pressEvents) window[method](name, block, true);
          window[method]("keydown", onKey, true);
          window[method]("keyup", onKeyUp, true);
          window[method]("scroll", onScroll, { capture: true, passive: true });
          window[method]("resize", onScroll);
          window[method]("pagehide", onHide);
        };
        const onHide = () => finish({ cancelled: true });
        const finish = (result) => {
          if (p.session !== session) return;
          p.session = null;
          listen(false);
          host.remove();
          adopt(cursor, false);
          resolve(result);
        };
        const pick = (el) => {
          const selector = selectorFor(el);
          el.style.setProperty("display", "none", "important");
          rules.add(selector);
          writeRules();
          finish({ selector });
        };
        const session = { finish };
        p.session = session;
        document.documentElement.append(host);
        adopt(cursor, true);
        listen(true);
        if (point) {
          current = target(point[0], point[1]);
          show();
        }
      });
    },
  });
}
`;

export function pickerCall(op: "start" | "cancel" | "apply" | "unhide", ...args: unknown[]): string {
  return `${INSTALL}\nwindow[Symbol.for("ardia.elementPicker")].ensure?.();\nPromise.resolve(window[Symbol.for("ardia.elementPicker")].${op}(...${JSON.stringify(args)})).then((v) => post("result", JSON.stringify(v)), () => post("result", "null"));`;
}
