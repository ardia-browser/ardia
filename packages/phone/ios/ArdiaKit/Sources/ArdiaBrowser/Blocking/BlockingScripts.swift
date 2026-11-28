import Foundation

enum BlockingScripts {
  static let handlerName = "ardiaBlocking"

  static let consent = #"""
  (async () => {
    const isTop = window.top === window;
    if (!isTop && !/trustarc|truste|consent|cmp|privacy|cookie|usercentrics|didomi|onetrust|cookiebot|sourcepoint|sp-prod|message_id=/i.test(location.hostname + location.pathname + location.search)) return;
    let allowed = false;
    try { allowed = await window.webkit.messageHandlers.ardiaBlocking.postMessage({ type: "consent" }); } catch (e) { return; }
    if (!allowed) return;

    const visible = (el) => !!el && el.isConnected && (el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0);
    const usable = (el) => !!el && el.isConnected && !el.disabled;
    const click = (el) => { if (!usable(el)) return false; el.click(); return true; };
    const first = (root, selectors) => {
      for (const s of selectors) for (const el of root.querySelectorAll(s)) if (usable(el) && visible(el)) return el;
      for (const s of selectors) for (const el of root.querySelectorAll(s)) if (usable(el)) return el;
      return null;
    };
    const hide = (selectors) => {
      for (const s of selectors) for (const el of document.querySelectorAll(s)) el.style.setProperty("display", "none", "important");
    };
    const lockedBy = (classes) => classes.length > 0 && [document.documentElement, document.body].some((el) => el && classes.some((c) => el.classList.contains(c)));
    const releaseLock = (classes) => {
      for (const el of [document.documentElement, document.body]) {
        if (!el) continue;
        el.classList.remove(...classes);
        if (getComputedStyle(el).overflow === "hidden") el.style.setProperty("overflow", "auto", "important");
      }
    };
    const unlockScroll = () => {
      for (const el of [document.documentElement, document.body]) {
        if (!el) continue;
        el.classList.remove("didomi-popup-open", "qc-cmp-ui-showing", "sp-message-open", "cmp-open", "ot-overflow-hidden", "cookie-consent-open", "modal-open");
        if (getComputedStyle(el).overflow === "hidden") el.style.setProperty("overflow", "auto", "important");
        if (getComputedStyle(el).position === "fixed" && el === document.body) el.style.setProperty("position", "static", "important");
      }
    };

    const platforms = [
      {
        detect: () => document.getElementById("onetrust-banner-sdk") || document.getElementById("onetrust-consent-sdk"),
        reject: () => click(first(document, ["#onetrust-reject-all-handler", ".ot-pc-refuse-all-handler", "#onetrust-pc-sdk .ot-pc-refuse-all-handler"])),
        leftovers: ["#onetrust-banner-sdk", "#onetrust-consent-sdk .onetrust-pc-dark-filter"],
        locks: ["ot-overflow-hidden"],
      },
      {
        detect: () => document.getElementById("CybotCookiebotDialog"),
        reject: () => click(first(document, ["#CybotCookiebotDialogBodyButtonDecline", "#CybotCookiebotDialogBodyLevelButtonLevelOptinDeclineAll", "[data-cookiebanner=\"reject_button\"]"])),
        leftovers: ["#CybotCookiebotDialog", "#CybotCookiebotDialogBodyUnderlay"],
      },
      {
        detect: () => document.getElementById("didomi-host") || document.querySelector(".didomi-popup-container"),
        reject: () => click(first(document, ["#didomi-notice-disagree-button", ".didomi-continue-without-agreeing", "#didomi-popup button.didomi-components-button--secondary[aria-label*=\"isagree\"]"])),
        leftovers: ["#didomi-host", ".didomi-popup-backdrop"],
        locks: ["didomi-popup-open"],
      },
      {
        detect: () => document.querySelector(".qc-cmp2-container, #qc-cmp2-container"),
        reject: () => click(first(document, [".qc-cmp2-summary-buttons button[mode=\"secondary\"]", ".qc-cmp2-footer button[mode=\"secondary\"]"])),
        leftovers: [".qc-cmp2-container", "#qc-cmp2-container"],
        locks: ["qc-cmp-ui-showing"],
      },
      {
        detect: () => document.getElementById("truste-consent-track") || document.querySelector(".truste_box_overlay, #truste-consent-buttons") || /trustarc|truste/i.test(location.hostname) ? document.body : null,
        reject: () => click(first(document, ["#truste-consent-required", "#truste-consent-reject", ".rejectAll", "#rejectAll", "a.call[aria-label*=\"eject\"]"])),
        leftovers: ["#truste-consent-track", ".truste_box_overlay", ".truste_overlay"],
      },
      {
        detect: () => document.getElementById("usercentrics-root") || document.getElementById("usercentrics-cmp-ui"),
        reject: () => {
          for (const id of ["usercentrics-root", "usercentrics-cmp-ui"]) {
            const host = document.getElementById(id);
            const root = host && host.shadowRoot;
            if (root && click(first(root, ["button[data-testid=\"uc-deny-all-button\"]", "button#deny", "button.deny", "[data-action-type=\"deny\"]"]))) return true;
          }
          return false;
        },
        leftovers: ["#usercentrics-root", "#usercentrics-cmp-ui"],
      },
      {
        detect: () => isTop ? null : document.querySelector(".sp_choice_type_13, .sp_choice_type_15, .sp_choice_type_SAVE_AND_EXIT"),
        reject: () => click(first(document, [".sp_choice_type_13", ".sp_choice_type_15"])),
        leftovers: [],
      },
      {
        detect: () => isTop ? document.querySelector('[id^="sp_message_container_"]') : null,
        reject: () => {
          for (const el of document.querySelectorAll('[id^="sp_message_container_"]')) el.style.setProperty("display", "none", "important");
          return true;
        },
        leftovers: ['[id^="sp_message_container_"]'],
      },
      {
        detect: () => document.getElementById("fides-banner") || document.getElementById("fides-overlay"),
        reject: () => click(first(document, ["#fides-banner .fides-reject-all-button", ".fides-reject-all-button"])),
        leftovers: ["#fides-overlay", "#fides-banner-container", "#fides-banner"],
      },
      {
        detect: () => {
          if (!isTop || !/(^|\.)cnn\.com$/.test(location.hostname)) return null;
          const heading = [...document.querySelectorAll("h1, h2, h3, p, div")].find((el) => el.childElementCount === 0 && /^Legal Terms and Privacy$/i.test((el.textContent || "").trim()));
          let node = heading;
          while (node && node !== document.body && getComputedStyle(node).position !== "fixed") node = node.parentElement;
          return node && node !== document.body ? node : null;
        },
        reject: () => {
          const heading = [...document.querySelectorAll("h1, h2, h3, p, div")].find((el) => el.childElementCount === 0 && /^Legal Terms and Privacy$/i.test((el.textContent || "").trim()));
          for (let node = heading; node && node !== document.body; node = node.parentElement) {
            if (getComputedStyle(node).position === "fixed") node.style.setProperty("display", "none", "important");
          }
          return Boolean(heading);
        },
        leftovers: [],
      },
      {
        detect: () => document.getElementById("bbccookies") || document.querySelector(".gdpr-lmd-wall, .gdpr-lmd-banner"),
        reject: () => {
          for (const el of document.querySelectorAll("#bbccookies, .gdpr-lmd-wall, .gdpr-lmd-banner")) el.style.setProperty("display", "none", "important");
          return true;
        },
        leftovers: [],
      },
      {
        detect: () => /(^|\.)consent\.(google|youtube)\./.test(location.hostname) ? document.body : null,
        reject: () => {
          const input = document.querySelector("form input[name=\"set_eom\"][value=\"true\"]");
          const form = input && input.form;
          return click(form && form.querySelector("button, input[type=\"submit\"]"));
        },
        leftovers: [],
      },
      {
        detect: () => /(^|\.)google\.[a-z.]+$/.test(location.hostname) ? document.getElementById("W0wltc") : null,
        reject: () => click(document.getElementById("W0wltc")),
        leftovers: [],
      },
    ];

    const done = new Set();
    const attempt = () => {
      for (const [index, platform] of platforms.entries()) {
        if (done.has(index)) continue;
        let found = null;
        try { found = platform.detect(); } catch (e) {}
        if (!found) continue;
        let rejected = false;
        try { rejected = platform.reject(); } catch (e) {}
        if (rejected) {
          done.add(index);
          setTimeout(() => { hide(platform.leftovers); unlockScroll(); }, 400);
        } else if (!visible(found) && lockedBy(platform.locks || [])) {
          releaseLock(platform.locks);
        }
      }
    };

    let scheduled = false;
    const observer = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      setTimeout(() => { scheduled = false; attempt(); }, 250);
    });
    attempt();
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 12000);
  })();
  """#

  static let counter = #"""
  (() => {
    const pending = [];
    let timer = 0;
    const flush = () => {
      timer = 0;
      const hosts = pending.splice(0, pending.length);
      if (!hosts.length) return;
      try { window.webkit.messageHandlers.ardiaBlocking.postMessage({ type: "blocked", hosts }).catch(() => {}); } catch (e) {}
    };
    const seen = new WeakSet();
    window.addEventListener("error", (event) => {
      const el = event.target;
      if (!el || el === window || !el.tagName || seen.has(el)) return;
      if (!/^(IMG|SCRIPT|LINK|IFRAME|VIDEO|AUDIO|SOURCE|EMBED|OBJECT)$/.test(el.tagName)) return;
      const src = el.currentSrc || el.src || el.href || el.data;
      if (!src || typeof src !== "string") return;
      let host = "";
      try { const url = new URL(src, location.href); if (!/^https?:$/.test(url.protocol)) return; host = url.hostname; } catch (e) { return; }
      seen.add(el);
      pending.push(host);
      if (pending.length > 500) pending.shift();
      if (!timer) timer = setTimeout(flush, 500);
    }, true);
  })();
  """#

  static let scriptlets = #"""
  ((table) => {
    const hostname = location.hostname;
    if (!hostname) return;
    const suffixes = [];
    for (let rest = hostname; rest.includes("."); rest = rest.slice(rest.indexOf(".") + 1)) suffixes.push(rest);
    const pick = (map) => suffixes.flatMap((host) => map[host] || []);
    const excepted = new Set(pick(table.exceptions || {}).map((body) => JSON.stringify(body)));
    if (excepted.has("[]")) return;
    const chosen = new Map();
    for (const body of pick(table.hosts || {})) {
      const key = JSON.stringify(body);
      if (!excepted.has(key)) chosen.set(key, body);
    }
    if (!chosen.size) return;

    const toRegExp = (pattern) => {
      const literal = /^\/(.+)\/([dgimsuvy]*)$/.exec(pattern);
      if (literal) return new RegExp(literal[1], literal[2]);
      return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    };
    const options = (list) => {
      const out = {};
      for (let i = 0; i + 1 < list.length; i += 2) out[list[i]] = list[i + 1];
      return out;
    };
    const constant = (raw) => {
      switch (raw) {
        case "undefined": return { value: undefined };
        case "false": return { value: false };
        case "true": return { value: true };
        case "null": return { value: null };
        case "''": case "emptyStr": return { value: "" };
        case "[]": case "emptyArr": return { value: [] };
        case "{}": case "emptyObj": return { value: {} };
        case "noopFunc": return { value: function () {} };
        case "trueFunc": return { value: function () { return true; } };
        case "falseFunc": return { value: function () { return false; } };
      }
      if (/^-?\d+$/.test(raw)) return { value: parseInt(raw, 10) };
      if (raw.startsWith("{") && raw.endsWith("}")) {
        try { return { value: JSON.parse(raw).value }; } catch (e) { return null; }
      }
      return { value: raw };
    };
    const owner = (chain) => {
      const parts = chain.split(".");
      const prop = parts.pop();
      let target = globalThis;
      for (const part of parts) {
        target = target == null ? undefined : target[part];
        if (target == null) return null;
      }
      return typeof target[prop] === "function" ? { target, prop } : null;
    };

    const scriptlets = {
      "trusted-replace-argument": (chain = "", position = "", raw = "", ...rest) => {
        if (!chain || position === "" || raw.startsWith("repl:") || raw.startsWith("add:")) return;
        const found = owner(chain);
        const replacement = constant(raw);
        if (!found || !replacement) return;
        const index = parseInt(position, 10) || 0;
        const extra = options(rest);
        const condition = extra.condition === undefined ? null : toRegExp(extra.condition);
        const original = found.target[found.prop];
        found.target[found.prop] = new Proxy(original, {
          apply(fn, self, args) {
            const at = index >= 0 ? index : args.length + index;
            if (at >= 0 && at < args.length && (condition === null || condition.test(String(args[at])))) {
              args = Array.from(args);
              args[at] = replacement.value;
            }
            return Reflect.apply(fn, self, args);
          },
        });
      },
    };
    scriptlets["trusted-ra"] = scriptlets["trusted-replace-argument"];

    for (const [name, ...args] of chosen.values()) {
      const run = scriptlets[name];
      if (!run) continue;
      try { run(...args); } catch (e) {}
    }
  })
  """#
}
