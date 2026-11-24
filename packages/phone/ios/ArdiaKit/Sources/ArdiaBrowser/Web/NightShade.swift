import Foundation

public enum NightShadeVerdict: String, Codable, Sendable {
  case light
  case dark
}

struct NightShadeBake: Equatable, Sendable {
  var mode: NightShadeMode
  var verdict: NightShadeVerdict?
}

enum PageScripts {
  static let handlerName = "ardiaPage"
  static let bakedStatePlaceholder = "__ARDIA_NIGHT_SHADE_BAKED__"

  static func nightShade(_ bake: NightShadeBake?) -> String {
    let state = bake.map { "{\"mode\":\"\($0.mode.rawValue)\",\"verdict\":\($0.verdict.map { "\"\($0.rawValue)\"" } ?? "null")}" } ?? "null"
    return nightShadeSource.replacingOccurrences(of: bakedStatePlaceholder, with: state)
  }

  static let nightShadeSource = #"""
  (() => {
    if (window.__ardiaNightShade) return;
    const STYLE_ID = "ardia-night-shade";
    const CSS = "html{filter:invert(1) hue-rotate(180deg)!important;background-color:#fff!important}" +
      "img,video,canvas,picture,iframe,embed,object,svg image,[style*=\"background-image\"]{filter:invert(1) hue-rotate(180deg)!important}" +
      "picture img{filter:none!important}";
    const baked = __ARDIA_NIGHT_SHADE_BAKED__;
    let mode = baked ? baked.mode : "disabled";
    let verdict = baked ? baked.verdict : null;
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.ardiaPage;

    const luminance = (color) => {
      const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/.exec(color || "");
      if (!m) return null;
      if (m[4] !== undefined && Number(m[4]) < 0.1) return null;
      const [r, g, b] = [m[1], m[2], m[3]].map((v) => {
        const c = Number(v) / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const stylesPending = () => [...document.querySelectorAll("link[rel~=stylesheet]")].some((link) => !link.sheet && !link.disabled);
    const pageIsLight = (early) => {
      const root = document.documentElement;
      if (!root) return early ? null : false;
      const scheme = getComputedStyle(root).colorScheme || "";
      if (/dark/.test(scheme) && (!/light/.test(scheme) || prefersDark.matches)) return false;
      for (const el of [document.body, root]) {
        if (!el) continue;
        const value = luminance(getComputedStyle(el).backgroundColor);
        if (value !== null) return value > 0.45;
      }
      return early && stylesPending() ? null : true;
    };
    const setStyle = (on) => {
      let style = document.getElementById(STYLE_ID);
      if (on && !style) {
        const parent = document.head || document.documentElement;
        if (!parent) return;
        style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = CSS;
        parent.appendChild(style);
      } else if (!on && style) {
        style.remove();
      }
    };
    const wanted = () => mode === "always" || (mode === "automatic" && prefersDark.matches);
    const report = (light) => {
      const measured = light ? "light" : "dark";
      if (measured === verdict) return;
      verdict = measured;
      try { handler().postMessage({ type: "nightShadeVerdict", verdict: measured }).catch(() => {}); } catch (e) {}
    };
    const evaluate = (reporting) => {
      if (!wanted()) return setStyle(false);
      setStyle(false);
      const light = pageIsLight();
      setStyle(light);
      if (reporting) report(light);
    };
    const settle = () => evaluate(true);
    window.__ardiaNightShade = (next) => { mode = next; settle(); };
    prefersDark.addEventListener("change", settle);

    const early = () => {
      if (!wanted() || verdict === "dark") return true;
      if (verdict === "light") {
        setStyle(true);
        return !!document.getElementById(STYLE_ID);
      }
      if (!document.body) return false;
      const light = pageIsLight(true);
      if (light !== null) setStyle(light);
      return true;
    };
    const watcher = new MutationObserver(() => {
      if (early()) watcher.disconnect();
    });
    if (document.readyState === "loading") {
      if (!early()) watcher.observe(document, { childList: true, subtree: true });
      document.addEventListener("DOMContentLoaded", () => { watcher.disconnect(); settle(); }, { once: true });
      window.addEventListener("load", settle, { once: true });
    } else {
      settle();
    }
    if (!baked) {
      (async () => {
        try { mode = await handler().postMessage({ type: "nightShade" }) || "disabled"; } catch (e) { mode = "disabled"; }
        if (document.readyState !== "loading") settle(); else if (!early()) watcher.observe(document, { childList: true, subtree: true });
      })();
    }
  })();
  """#
}
