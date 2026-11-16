(() => {
  "use strict";
  const SVG_NS = "http://www.w3.org/2000/svg";
  const MATH_NS = "http://www.w3.org/1998/Math/MathML";
  const XLINK_NS = "http://www.w3.org/1999/xlink";
  const XML_NS = "http://www.w3.org/XML/1998/namespace";
  const BLOCKED_TAGS = new Set(["script", "iframe", "frame", "frameset", "object", "embed", "portal", "fencedframe", "applet", "meta", "base", "link", "style", "template", "noscript", "param", "track", "audio", "source"]);
  const URL_ATTRS = new Set(["href", "src", "xlink:href", "action", "formaction", "data", "poster", "background", "ping", "srcset", "lowsrc"]);
  const STATES = new Set(["hover", "active", "focus", "focus-within", "focus-visible", "fullscreen", "popover-open", "modal", "clear"]);
  const TAG = /^[A-Za-z][A-Za-z0-9._-]*$/;
  const ATTR = /^[A-Za-z_:][A-Za-z0-9_.:-]*$/;
  const BASE_RULES = [
    "html,body{background:transparent!important;margin:0!important;overflow:hidden!important}",
    "[data-ardia-shell]{background:transparent!important;transform:none!important;filter:none!important;backdrop-filter:none!important;contain:none!important;perspective:none!important;will-change:auto!important;clip-path:none!important;mask:none!important;opacity:1!important;visibility:visible!important;overflow:visible!important;box-shadow:none!important;border-color:transparent!important}",
    "[data-ardia-clear]{background-color:transparent!important;background-image:none!important}",
    "video{visibility:hidden!important}",
    "*,*::before,*::after{pointer-events:none!important;cursor:default!important;caret-color:transparent!important}",
  ].join("\n");

  const base = new CSSStyleSheet();
  base.replaceSync(`@layer ardia-mirror{${BASE_RULES}}`);
  const agent = new CSSStyleSheet();
  agent.replaceSync("[data-ardia-focus-visible]{outline:-webkit-focus-ring-color auto 1px}");
  const rootFrame = new CSSStyleSheet();
  const nodes = new Map();
  const idOfNode = new WeakMap();
  const sheets = new Map();
  const flagged = new Map();
  const shadows = new Map();
  const scopeSheetLists = new Map();
  let rootId = 0;
  let documentSheets = [];
  let detached = [];
  let formValues = [];
  let scrolls = [];
  document.adoptedStyleSheets = [agent, base, rootFrame];

  class Resync extends Error {}
  const need = (id) => {
    const n = nodes.get(id);
    if (!n) throw new Resync();
    return n;
  };
  const remember = (id, n) => {
    nodes.set(id, n);
    idOfNode.set(n, id);
  };
  const managed = (name) => name.startsWith("data-ardia-") && name !== "data-ardia-undefined";
  const safeValue = (name, value) => {
    const lower = name.toLowerCase();
    if (lower.startsWith("on") || lower === "srcdoc" || lower === "nonce" || lower === "autofocus" || lower === "is") return false;
    if (typeof value !== "string") return false;
    return !(URL_ATTRS.has(lower) && /^(javascript|vbscript|blob):/.test(value.replace(/[\u0000-\u0020]/g, "").toLowerCase()));
  };
  const writeAttr = (el, name, value) => {
    try {
      if (name.startsWith("xlink:")) el.setAttributeNS(XLINK_NS, name, value);
      else if (name.startsWith("xml:")) el.setAttributeNS(XML_NS, name, value);
      else if (!name.startsWith("xmlns")) el.setAttribute(name, value);
    } catch (e) {}
  };
  const setAttrs = (el, list) => {
    const wanted = new Map();
    for (const pair of Array.isArray(list) ? list : []) {
      if (!Array.isArray(pair) || typeof pair[0] !== "string" || !ATTR.test(pair[0]) || managed(pair[0])) continue;
      if (safeValue(pair[0], pair[1])) wanted.set(pair[0], pair[1]);
    }
    for (const attr of [...el.attributes]) if (!managed(attr.name) && !wanted.has(attr.name)) el.removeAttributeNode(attr);
    for (const [name, value] of wanted) if (el.getAttribute(name) !== value) writeAttr(el, name, value);
  };
  const createElement = (tag, ns) => {
    const name = typeof tag === "string" && TAG.test(tag) && !BLOCKED_TAGS.has(tag.toLowerCase()) ? tag : "div";
    try {
      if (ns === "s") return document.createElementNS(SVG_NS, name);
      if (ns === "m") return document.createElementNS(MATH_NS, name);
      return document.createElement(name);
    } catch (e) {
      return document.createElement("div");
    }
  };
  const paintCanvas = (canvas, url) => {
    if (typeof url !== "string" || !url.startsWith("data:image/")) return;
    const picture = new Image();
    picture.onload = () => {
      const context = canvas.getContext("2d");
      if (!context) return;
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(picture, 0, 0, canvas.width, canvas.height);
    };
    picture.src = url;
  };
  const scopeSheets = (extra) => [agent, ...extra, base];
  const attachShadowTo = (host, description) => {
    let root = host.shadowRoot;
    if (!root) {
      try {
        root = host.attachShadow({ mode: "open" });
      } catch (e) {
        return;
      }
      root.adoptedStyleSheets = scopeSheets([]);
    }
    shadows.set(idOfNode.get(host), root);
    root.replaceChildren(...build(description && description.c));
  };
  const build = (list) => (Array.isArray(list) ? list.map(make) : []);
  const make = (d) => {
    if (!d || typeof d !== "object") throw new Resync();
    if (d.r) return need(d.r);
    if (typeof d.x === "string" && !d.t) {
      const text = document.createTextNode(d.x);
      remember(d.i, text);
      return text;
    }
    const el = createElement(d.t, d.n);
    remember(d.i, el);
    setAttrs(el, d.a);
    if (el.localName === "canvas") paintCanvas(el, d.cv);
    if (Array.isArray(d.c)) el.append(...build(d.c));
    if (d.sh) attachShadowTo(el, d.sh);
    if ("v" in d || "k" in d) formValues.push([el, d.v, d.k]);
    if ("sx" in d || "sy" in d) scrolls.push([el, d.sx, d.sy]);
    return el;
  };
  const noteDetached = (parent) => {
    for (let n = parent.firstChild; n; n = n.nextSibling) detached.push(n);
  };
  const forget = (n) => {
    const id = idOfNode.get(n);
    if (id !== undefined && nodes.get(id) === n) nodes.delete(id);
    if (shadows.get(id) === n.shadowRoot) {
      shadows.delete(id);
      scopeSheetLists.delete(id);
    }
    for (let c = n.firstChild; c; c = c.nextSibling) forget(c);
    if (n.shadowRoot) for (let c = n.shadowRoot.firstChild; c; c = c.nextSibling) forget(c);
  };
  const putSheet = (op) => {
    if (typeof op.x === "string") {
      let sheet = sheets.get(op.id);
      const swapped = !(sheet instanceof CSSStyleSheet);
      if (swapped) sheets.set(op.id, (sheet = new CSSStyleSheet()));
      try {
        sheet.replaceSync(op.x);
      } catch (e) {}
      if (swapped) for (const [i, l] of [...scopeSheetLists]) if (l.includes(op.id)) listSheets({ i, l });
    } else if (typeof op.h === "string" && /^https:/.test(op.h)) sheets.set(op.id, { h: op.h, m: typeof op.m === "string" ? op.m : "" });
  };
  const listSheets = (op) => {
    const ids = Array.isArray(op.l) ? op.l : [];
    scopeSheetLists.set(op.i, ids);
    const constructed = ids.map((id) => sheets.get(id)).filter((sheet) => sheet instanceof CSSStyleSheet);
    if (op.i === 0) {
      document.adoptedStyleSheets = [agent, ...constructed, base, rootFrame];
      documentSheets = ids;
      syncLinks();
      return;
    }
    const root = shadows.get(op.i);
    if (root) root.adoptedStyleSheets = scopeSheets(constructed);
  };
  const syncLinks = () => {
    const wanted = new Map();
    for (const id of documentSheets) {
      const sheet = sheets.get(id);
      if (sheet && !(sheet instanceof CSSStyleSheet)) wanted.set(String(id), sheet);
    }
    for (const link of [...document.head.querySelectorAll("link[data-ardia-sheet]")]) {
      if (wanted.has(link.dataset.ardiaSheet)) wanted.delete(link.dataset.ardiaSheet);
      else link.remove();
    }
    for (const [id, sheet] of wanted) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = sheet.h;
      if (sheet.m) link.media = sheet.m;
      link.dataset.ardiaSheet = id;
      document.head.append(link);
    }
  };
  const setState = (key, ids) => {
    if (!STATES.has(key)) return;
    const attr = "data-ardia-" + key;
    for (const el of flagged.get(key) || []) el.removeAttribute(attr);
    const now = [];
    for (const id of Array.isArray(ids) ? ids : []) {
      const el = nodes.get(id);
      if (el && el.nodeType === 1) {
        el.setAttribute(attr, "");
        now.push(el);
      }
    }
    flagged.set(key, now);
  };
  const px = (v) => (Number.isFinite(v) ? v : 0) + "px";
  const placeRoot = (op) => {
    rootFrame.replaceSync(
      `[data-ardia-root]{position:fixed!important;right:auto!important;bottom:auto!important;left:${px(op.x)}!important;top:${px(op.y)}!important;` +
        `width:${px(op.w)}!important;height:${px(op.h)}!important;margin:0!important;transform:none!important;box-sizing:border-box!important;` +
        "max-width:none!important;max-height:none!important;min-width:0!important;min-height:0!important;translate:none!important;scale:none!important}",
    );
  };
  const applyOp = (op) => {
    switch (op && op.o) {
      case "put":
        return putSheet(op);
      case "sl":
        return listSheets(op);
      case "c": {
        const host = need(op.i);
        const target = op.s ? shadows.get(op.i) : host;
        if (!target) throw new Resync();
        noteDetached(target);
        return target.replaceChildren(...build(op.c));
      }
      case "sr":
        return attachShadowTo(need(op.i), op.sh);
      case "a":
        return setAttrs(need(op.i), op.a);
      case "x":
        need(op.i).data = typeof op.x === "string" ? op.x : "";
        return;
      case "v":
        return formValues.push([need(op.i), op.v, op.k]);
      case "sc":
        return scrolls.push([need(op.i), op.x, op.y]);
      case "st":
        return setState(op.k, op.l);
      case "f":
        return placeRoot(op);
    }
  };
  const applySnapshot = (batch) => {
    for (const key of flagged.keys()) setState(key, []);
    nodes.clear();
    shadows.clear();
    for (const key of [...scopeSheetLists.keys()]) if (key !== 0) scopeSheetLists.delete(key);
    rootId = 0;
    document.body.replaceChildren();
    const shells = Array.isArray(batch.shells) ? batch.shells : [];
    let parent = null;
    shells.forEach((shell, index) => {
      let el;
      if (index === 0 && shell.t === "html") el = document.documentElement;
      else if (index === 1 && shell.t === "body") el = document.body;
      else {
        el = createElement(shell.t);
        (parent || document.body).append(el);
      }
      setAttrs(el, shell.a);
      el.setAttribute("data-ardia-shell", "");
      remember(shell.i, el);
      parent = el;
    });
    const root = make(batch.root);
    if (root.nodeType !== 1) throw new Resync();
    root.setAttribute("data-ardia-root", "");
    rootId = batch.root.i;
    (parent || document.body).append(root);
  };
  const finish = () => {
    for (const [el, value, checked] of formValues) {
      if (typeof checked === "boolean" && "checked" in el) el.checked = checked;
      else if (typeof value === "string" && "value" in el) el.value = value;
    }
    for (const [el, x, y] of scrolls) {
      if (Number.isFinite(x)) el.scrollLeft = x;
      if (Number.isFinite(y)) el.scrollTop = y;
    }
    for (const n of detached) if (!n.isConnected) forget(n);
  };
  window.ardiaVideoMirror = (text) => {
    const started = performance.now();
    formValues = [];
    scrolls = [];
    detached = [];
    try {
      const batch = JSON.parse(text);
      if (!batch || (batch.t !== "s" && batch.t !== "p")) throw new Resync();
      if (batch.t === "p" && !rootId) throw new Resync();
      if (batch.t === "s") applySnapshot(batch);
      for (const op of Array.isArray(batch.ops) ? batch.ops : []) applyOp(op);
      for (const op of Array.isArray(batch.pre) ? batch.pre : []) applyOp(op);
      finish();
      return { ok: true, kind: batch.t, ms: performance.now() - started, pageMs: Number(batch.pm) || 0, sentAt: Number(batch.pt) || 0, nodes: nodes.size };
    } catch (e) {
      return { ok: false, resync: true, error: String((e && e.message) || e).slice(0, 200) };
    }
  };
})();
