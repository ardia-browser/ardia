(baked) => {
  if (window.__ardiaNightShade) return;
  const STYLE_ID = "ardia-night-shade";
  const VERDICT_MESSAGE = "nightShadeVerdict:";
  const CSS = "html{filter:invert(1) hue-rotate(180deg)!important;background-color:#fff!important}" +
    "img,video,canvas,picture,iframe,embed,object,svg image,[style*=\"background-image\"]{filter:invert(1) hue-rotate(180deg)!important}" +
    "picture img{filter:none!important}";
  const bridge = window.ardiaPage;
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)");
  const host = location.hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
  let mode = null;
  let given = "unknown";

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
    if (!on) {
      if (style) style.remove();
      return;
    }
    const parent = document.head || document.documentElement;
    if (!parent || (style && style.parentNode === parent)) return;
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = CSS;
    }
    parent.appendChild(style);
  };
  const wanted = () => mode === "always" || (mode === "automatic" && prefersDark.matches);
  const measure = (early) => {
    const shaded = !!document.getElementById(STYLE_ID);
    setStyle(false);
    const light = pageIsLight(early);
    setStyle(light === null ? shaded : light);
    return light === null ? null : light ? "light" : "dark";
  };
  const apply = () => {
    if (mode === null) return;
    if (!wanted()) return setStyle(false);
    const loading = document.readyState === "loading";
    if (!document.body || (loading && given !== "unknown")) return setStyle(given === "light");
    const measured = measure(loading);
    if (loading || measured === given) return;
    given = measured;
    if (bridge) bridge.postMessage(VERDICT_MESSAGE + measured);
  };
  const watcher = new MutationObserver(() => {
    if (document.body) watcher.disconnect();
    apply();
  });
  const follow = () => {
    apply();
    if (wanted() && !document.body && document.readyState === "loading") watcher.observe(document, { childList: true, subtree: true });
  };
  const start = (state) => {
    mode = state.mode || "disabled";
    given = state.verdict === "light" || state.verdict === "dark" ? state.verdict : "unknown";
    follow();
  };
  window.__ardiaNightShade = (next) => { mode = next; follow(); };
  prefersDark.addEventListener("change", follow);
  document.addEventListener("load", (event) => {
    if (given === "unknown" && document.readyState === "loading" && event.target instanceof HTMLLinkElement && /stylesheet/i.test(event.target.rel)) apply();
  }, true);
  document.addEventListener("DOMContentLoaded", apply);
  window.addEventListener("load", apply);
  if (baked && baked.host === host) start(baked);
  else if (bridge) {
    const answer = (event) => {
      bridge.removeEventListener("message", answer);
      const [nextMode, verdict] = String(event.data).split(" ");
      start({ mode: nextMode, verdict });
    };
    bridge.addEventListener("message", answer);
    try { bridge.postMessage("nightShade"); } catch (e) { bridge.removeEventListener("message", answer); }
  }
}
