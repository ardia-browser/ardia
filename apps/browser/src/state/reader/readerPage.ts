import { READABILITY, READERABLE } from "./readabilitySource";
import { READER_FONT_STACKS, READER_FONTS, READER_SHEET, READER_SIZES } from "./tokens";

export type ReaderLook = { dark: boolean; size: number; font: (typeof READER_FONTS)[number] };
export type ReaderReport = { active: boolean; readerable?: boolean; noArticle?: boolean; look?: ReaderLook };

const INSTALL = String.raw`
const KEY = Symbol.for("ardia.reader");
if (!window[KEY]) {
  const SIZES = ${JSON.stringify(READER_SIZES)};
  const FONTS = ${JSON.stringify({ serif: READER_FONT_STACKS.serif, sans: READER_FONT_STACKS.sans })};
  const SHEET = ${JSON.stringify(READER_SHEET)};
  const MAX_MARKED = 40000;
  const ICON_MAX = 48;
  const LAZY = ["data-src", "data-srcset", "data-lazy-src", "data-original", "data-lazy", "data-url"];
  const isIcon = (img) => img.complete && img.naturalWidth > 0 && img.naturalWidth < ICON_MAX && img.naturalHeight < ICON_MAX && !LAZY.some((name) => img.hasAttribute(name)) && !(img.parentElement?.textContent || "").trim();
  const UNMARKED = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SOURCE|TRACK|PARAM|BR|WBR|META|LINK)$/;
  const SCREEN_READER_ONLY = /(^|[\s_-])(sr-only|visually-?hidden|screen-reader-text|a11y-hidden|offscreen)($|[\s_-])/i;
  const CLUTTER = "script,style,link,meta,noscript,template,button,input,select,textarea,nav,aside,dialog,[hidden],[aria-hidden=true]";
  const make = (tag, cls, text) => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text) el.textContent = text;
    return el;
  };
  const same = (a, b) => (a || "").replace(/\s+/g, " ").trim().toLowerCase() === (b || "").replace(/\s+/g, " ").trim().toLowerCase();
  const r = (window[KEY] = {
    host: null,
    scroller: null,
    bar: null,
    url: "",
    shown: false,
    saved: null,
    readTop: 0,
    look: { dark: false, size: 1, font: "serif" },
    styled: false,
    report(extra) {
      return Object.assign({ active: this.shown, look: this.styled ? Object.assign({}, this.look) : undefined }, extra || {});
    },
    check(isProbablyReaderable) {
      let readerable = false;
      try {
        readerable = !!document.body && isProbablyReaderable(document);
      } catch (e) {}
      return this.report({ readerable: readerable || this.shown });
    },
    state() {
      if (this.shown && !this.host.isConnected) this.hide();
      return this.report();
    },
    mark(clone) {
      const live = document.body ? Array.from(document.body.getElementsByTagName("*")) : [];
      const copy = clone.body ? Array.from(clone.body.getElementsByTagName("*")) : [];
      if (live.length !== copy.length || live.length > MAX_MARKED) return;
      let hiddenRoot = null;
      const gone = [];
      for (let i = 0; i < live.length; i++) {
        const el = live[i], twin = copy[i];
        if (hiddenRoot && hiddenRoot.contains(el)) continue;
        if (el.tagName === "IMG") {
          if (isIcon(el)) {
            gone.push(twin);
            continue;
          }
          const src = el.currentSrc;
          if (src && !src.startsWith("data:") && el.naturalWidth > 2) {
            twin.setAttribute("src", src);
            twin.removeAttribute("srcset");
            twin.removeAttribute("sizes");
            twin.removeAttribute("loading");
            const picture = twin.parentElement;
            if (picture && picture.tagName === "PICTURE") for (const source of Array.from(picture.querySelectorAll("source"))) source.remove();
          }
        }
        if (UNMARKED.test(el.tagName) || el.closest("details:not([open])")) continue;
        const cls = el.getAttribute("class") || "";
        const hidden = SCREEN_READER_ONLY.test(cls) || (typeof el.checkVisibility === "function" && !el.checkVisibility() && !el.querySelector("p"));
        if (hidden) {
          hiddenRoot = el;
          gone.push(twin);
        }
      }
      for (const twin of gone) twin.remove();
    },
    extract(Readability) {
      try {
        const clone = document.cloneNode(true);
        this.mark(clone);
        const article = new Readability(clone, { serializer: (el) => el, charThreshold: 400 }).parse();
        return article && article.content && (article.length || 0) >= 200 ? article : null;
      } catch (e) {
        return null;
      }
    },
    tidy(body, title, author) {
      for (const el of Array.from(body.querySelectorAll(CLUTTER))) el.remove();
      for (const form of Array.from(body.querySelectorAll("form"))) if (!form.querySelector("p")) form.remove();
      for (const img of Array.from(body.querySelectorAll("img"))) {
        const src = img.getAttribute("src") || "";
        if (!src || (src.startsWith("data:") && src.length < 200)) img.remove();
        else {
          img.removeAttribute("loading");
          img.setAttribute("decoding", "async");
        }
      }
      for (const video of Array.from(body.querySelectorAll("video"))) {
        video.removeAttribute("autoplay");
        video.setAttribute("controls", "");
        video.setAttribute("preload", "metadata");
      }
      for (const frame of Array.from(body.querySelectorAll("iframe"))) {
        frame.removeAttribute("width");
        frame.removeAttribute("height");
        frame.setAttribute("loading", "lazy");
      }
      const first = body.querySelector("h1, h2");
      if (first && same(first.textContent, title)) first.remove();
      if (author) {
        const leading = Array.from(body.querySelectorAll("p, div, span, address")).slice(0, 8);
        const credit = leading.find((el) => same(el.textContent.replace(/^\s*by\s+/i, ""), author));
        if (credit) credit.remove();
      }
      const boxes = body.querySelectorAll("figure, picture, div, section, p");
      for (let i = boxes.length - 1; i >= 0; i--) {
        const box = boxes[i];
        if (!box.textContent.trim() && !box.querySelector("img, video, audio, iframe, svg, canvas, table, hr, math")) box.remove();
      }
    },
    button(cls, text, title, run) {
      const b = make("button", cls, text);
      b.type = "button";
      b.title = title;
      b.setAttribute("aria-label", title);
      b.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        run();
      });
      return b;
    },
    build(article) {
      const host = document.createElement("ardia-reader");
      const shadow = host.attachShadow({ mode: "closed" });
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(SHEET);
      shadow.adoptedStyleSheets = [sheet];
      const scroller = make("div", "scroller");
      scroller.tabIndex = -1;
      const page = make("article", "column");
      if (article.lang) page.lang = article.lang;
      if (article.dir) page.dir = article.dir;
      const title = (article.title || document.title || "").trim();
      const words = (article.textContent || "").trim().split(/\s+/).length;
      const minutes = Math.max(1, Math.round(words / 230));
      const author = (article.byline || "").replace(/\s+/g, " ").trim();
      const head = make("header", "masthead");
      head.append(make("p", "source", (article.siteName || location.hostname.replace(/^www\./, "")).trim()));
      if (title) head.append(make("h1", "headline", title));
      head.append(make("p", "credit", [author, minutes + " min read"].filter(Boolean).join(" · ")));
      const body = make("div", "body");
      body.append(document.importNode(article.content, true));
      this.tidy(body, title, author);
      page.append(head, body);
      scroller.append(page);
      const bar = make("div", "bar");
      this.smaller = this.button("small", "A", "Smaller Text", () => this.setLook({ size: this.look.size - 1 }));
      this.larger = this.button("large", "A", "Larger Text", () => this.setLook({ size: this.look.size + 1 }));
      this.face = this.button("sans", "Aa", "Use Sans-Serif", () => this.setLook({ font: this.look.font === "serif" ? "sans" : "serif" }));
      bar.append(this.smaller, this.larger, this.face, this.button("close", "✕", "Close Reader (Esc)", () => this.hide()));
      shadow.append(scroller, bar);
      shadow.addEventListener("click", (e) => {
        const link = e.target && e.target.closest ? e.target.closest("a[href]") : null;
        const href = link ? link.getAttribute("href") || "" : "";
        if (!href.startsWith("#") || href.length < 2) return;
        const id = decodeURIComponent(href.slice(1));
        const target = shadow.getElementById(id) || shadow.querySelector('[name="' + CSS.escape(id) + '"]');
        if (!target) return;
        e.preventDefault();
        target.scrollIntoView({ block: "start" });
      });
      this.host = host;
      this.scroller = scroller;
      this.bar = bar;
      this.readTop = 0;
      this.url = location.href;
    },
    setLook(look) {
      const next = Object.assign({}, this.look, look || {});
      next.size = Math.max(0, Math.min(SIZES.length - 1, Math.round(Number(next.size) || 0)));
      next.font = next.font === "sans" ? "sans" : "serif";
      next.dark = !!next.dark;
      this.look = next;
      this.styled = true;
      if (this.scroller) {
        const theme = next.dark ? "dark" : "light";
        this.scroller.setAttribute("data-theme", theme);
        this.bar.setAttribute("data-theme", theme);
        this.scroller.style.setProperty("--size", SIZES[next.size] + "px");
        this.scroller.style.setProperty("--font", FONTS[next.font]);
        this.smaller.disabled = next.size === 0;
        this.larger.disabled = next.size === SIZES.length - 1;
        const other = next.font === "serif" ? "sans" : "serif";
        this.face.className = other;
        this.face.title = other === "sans" ? "Use Sans-Serif" : "Use Serif";
        this.face.setAttribute("aria-label", this.face.title);
      }
      return this.report();
    },
    onKey(e) {
      if (!r.shown) return;
      if (e.type === "keydown" && e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        e.stopImmediatePropagation();
        r.hide();
        return;
      }
      if (e.composedPath().includes(r.host)) e.stopImmediatePropagation();
    },
    show() {
      const root = document.documentElement;
      this.saved = {
        overflow: root.style.getPropertyValue("overflow"),
        priority: root.style.getPropertyPriority("overflow"),
        inert: document.body ? document.body.inert : false,
        focus: document.activeElement,
      };
      root.style.setProperty("overflow", "hidden", "important");
      if (document.body) document.body.inert = true;
      root.appendChild(this.host);
      try {
        this.host.popover = "manual";
        this.host.showPopover();
      } catch (e) {}
      this.scroller.scrollTop = this.readTop;
      this.scroller.focus({ preventScroll: true });
      window.addEventListener("keydown", this.onKey, true);
      window.addEventListener("keypress", this.onKey, true);
      this.shown = true;
    },
    hide() {
      if (!this.shown) return this.report();
      this.shown = false;
      window.removeEventListener("keydown", this.onKey, true);
      window.removeEventListener("keypress", this.onKey, true);
      this.readTop = this.scroller.scrollTop;
      try {
        this.host.hidePopover();
      } catch (e) {}
      this.host.remove();
      const root = document.documentElement;
      const saved = this.saved || {};
      if (saved.overflow) root.style.setProperty("overflow", saved.overflow, saved.priority);
      else root.style.removeProperty("overflow");
      if (document.body) document.body.inert = !!saved.inert;
      if (saved.focus && saved.focus.isConnected && saved.focus.focus) saved.focus.focus({ preventScroll: true });
      this.saved = null;
      return this.report();
    },
    open(Readability, look) {
      if (this.shown) return this.setLook(look);
      if (!this.host || this.url !== location.href) {
        const article = this.extract(Readability);
        if (!article) return this.report({ noArticle: true });
        this.build(article);
      }
      this.setLook(look);
      this.show();
      return this.report();
    },
    toggle(Readability, look) {
      return this.shown ? this.hide() : this.open(Readability, look);
    },
  });
}
`;

const reader = `window[Symbol.for("ardia.reader")]`;
const run = (expression: string) => `${INSTALL}\npost("result", JSON.stringify(${expression}));`;

export const readerCheckCall = () => run(`${reader}.check(${READERABLE})`);
export const readerToggleCall = (look: ReaderLook) => run(`${reader}.toggle(${READABILITY}, ${JSON.stringify(look)})`);
export const readerOpenCall = (look: ReaderLook) => run(`${reader}.open(${READABILITY}, ${JSON.stringify(look)})`);
export const readerCall = (op: "state" | "hide" | "setLook", ...args: unknown[]) => run(`${reader}.${op}(...${JSON.stringify(args)})`);
