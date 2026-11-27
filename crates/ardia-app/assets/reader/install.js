
const KEY = Symbol.for("ardia.reader");
if (!window[KEY]) {
  const SIZES = [16,18,20,23,26];
  const FONTS = {"serif":"ui-serif, \"New York\", Charter, \"Iowan Old Style\", Georgia, serif","sans":"-apple-system, BlinkMacSystemFont, system-ui, \"Helvetica Neue\", sans-serif"};
  const SHEET = ":host{all:initial !important;display:block !important;position:fixed !important;inset:0 !important;width:auto !important;height:auto !important;max-width:none !important;max-height:none !important;margin:0 !important;padding:0 !important;border:0 !important;overflow:hidden !important;z-index:2147483647 !important;background:none !important;contain:strict !important;visibility:visible !important;opacity:1 !important;}.scroller{position:absolute;inset:0;overflow-x:hidden;overflow-y:auto;outline:none;background:var(--ground);color:var(--ink);color-scheme:light;--ground:#FFFFFF;--ink:#1F1F1F;--quiet:#8A8A8E;--aside:#545458;--rule:#E6E6E6;--code:#F4F4F5;--wash:rgba(0, 0, 0, 0.06);--bar:rgba(255, 255, 255, 0.92);--picture:none;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;}.scroller[data-theme=dark]{color-scheme:dark;--ground:#1C1C1E;--ink:#E2E2E4;--quiet:#8E8E93;--aside:#ABABB0;--rule:#3A3A3C;--code:#2C2C2E;--wash:rgba(255, 255, 255, 0.08);--bar:rgba(44, 44, 46, 0.92);--picture:brightness(0.92);}.column{box-sizing:content-box;max-width:65ch;margin:0 auto;padding:72px 28px 160px;font-family:var(--font);font-size:var(--size);line-height:1.65;overflow-wrap:break-word;}.masthead{margin:0 0 2.2em;}.source{font:500 12px/1.4 -apple-system, BlinkMacSystemFont, system-ui, \"Helvetica Neue\", sans-serif;color:var(--quiet);text-transform:uppercase;letter-spacing:.06em;margin:0 0 14px;}.headline{font-family:var(--font);font-size:1.8em;font-weight:700;line-height:1.18;letter-spacing:-0.01em;margin:0 0 12px;}.credit{font:400 14px/1.5 -apple-system, BlinkMacSystemFont, system-ui, \"Helvetica Neue\", sans-serif;color:var(--aside);margin:0;}.body p{margin:0 0 1.2em;}.body h1,.body h2,.body h3,.body h4,.body h5,.body h6{font-family:var(--font);line-height:1.3;margin:1.8em 0 .6em;}.body h1{font-size:1.45em;}.body h2{font-size:1.3em;}.body h3{font-size:1.15em;}.body h4,.body h5,.body h6{font-size:1em;}.body a{color:inherit;text-decoration:underline;text-decoration-color:var(--quiet);text-underline-offset:3px;}.body a:hover{text-decoration-color:var(--ink);}.body img,.body video,.body iframe,.body svg{max-width:100%;}.body img,.body video{height:auto;display:block;margin:1.5em auto;border-radius:6px;filter:var(--picture);}.body iframe{display:block;width:100%;aspect-ratio:16/9;height:auto;border:0;margin:1.5em 0;}.body figure{margin:1.8em 0;}.body figure img,.body figure video{margin:0 auto;}.body figcaption{font:400 13px/1.5 -apple-system, BlinkMacSystemFont, system-ui, \"Helvetica Neue\", sans-serif;color:var(--quiet);margin-top:.6em;}.body blockquote{margin:1.5em 0;padding:0 0 0 1.1em;border-left:3px solid var(--rule);color:var(--aside);}.body ul,.body ol{margin:0 0 1.2em;padding-left:1.4em;}.body ul{list-style:disc outside;}.body ol{list-style:decimal outside;}.body li{margin:.3em 0;}.body li>ul,.body li>ol{margin-bottom:0;}.body pre,.body code,.body kbd,.body samp{font-family:ui-monospace, \"SF Mono\", Menlo, monospace;font-size:.82em;}.body pre{background:var(--code);padding:14px 16px;border-radius:8px;overflow:auto;line-height:1.5;}.body :not(pre)>code{background:var(--code);padding:.1em .35em;border-radius:4px;}.body hr{border:0;border-top:1px solid var(--rule);margin:2.4em 0;}.body table{border-collapse:collapse;display:block;overflow-x:auto;max-width:100%;font:400 15px/1.5 -apple-system, BlinkMacSystemFont, system-ui, \"Helvetica Neue\", sans-serif;margin:0 0 1.2em;}.body th,.body td{border-bottom:1px solid var(--rule);padding:8px 12px 8px 0;text-align:left;vertical-align:top;}.body th{font-weight:600;}.body sup,.body sub{line-height:0;}.body details{margin:0 0 1.2em;}.body summary{cursor:pointer;}.bar{position:absolute;top:12px;right:18px;z-index:1;display:flex;gap:2px;padding:3px;border-radius:999px;background:var(--bar);border:1px solid var(--rule);opacity:.55;transition:opacity 0.15s ease;font:500 12px/1 -apple-system, BlinkMacSystemFont, system-ui, \"Helvetica Neue\", sans-serif;--ground:#FFFFFF;--ink:#1F1F1F;--quiet:#8A8A8E;--aside:#545458;--rule:#E6E6E6;--code:#F4F4F5;--wash:rgba(0, 0, 0, 0.06);--bar:rgba(255, 255, 255, 0.92);--picture:none;color-scheme:light;}.bar[data-theme=dark]{--ground:#1C1C1E;--ink:#E2E2E4;--quiet:#8E8E93;--aside:#ABABB0;--rule:#3A3A3C;--code:#2C2C2E;--wash:rgba(255, 255, 255, 0.08);--bar:rgba(44, 44, 46, 0.92);--picture:brightness(0.92);color-scheme:dark;}.bar:hover,.bar:focus-within{opacity:1;}.bar button{all:unset;box-sizing:border-box;min-width:28px;height:24px;padding:0 7px;border-radius:999px;display:inline-flex;align-items:center;justify-content:center;color:var(--aside);cursor:default;}.bar button:hover{background:var(--wash);color:var(--ink);}.bar button:focus-visible{outline:2px solid var(--quiet);outline-offset:-2px;}";
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
      bar.append(this.button("close", "✕", "Close Reader (Esc)", () => this.hide()));
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

