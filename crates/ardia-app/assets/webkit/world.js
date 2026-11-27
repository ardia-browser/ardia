(() => {
  if (window.__ardia) return;
  const isTop = window === window.top;
  const frame = Math.random().toString(36).slice(2);
  const post = (kind, data) => {
    try {
      window.webkit.messageHandlers.ardia.postMessage({ kind, data: data === undefined ? null : data, frame });
    } catch (e) {}
  };
  let muted = false;
  const mutedByUs = new WeakSet();
  const mediaEvents = ["play", "playing", "pause", "ended", "volumechange", "emptied", "loadedmetadata", "seeked", "ratechange"];
  const detached = new Set();
  const listened = new WeakSet();
  const heard = new WeakSet();
  let lastMedia = null;
  let lastHeard = null;
  let pageActions = [];
  let pagePosition = null;
  const handlers = Object.create(null);
  const allMedia = () => {
    const list = Array.from(document.querySelectorAll("video, audio"));
    for (const m of detached) if (!list.includes(m)) list.push(m);
    return list;
  };
  const playing = (m) => !m.paused && !m.ended;
  const audible = (m) => playing(m) && !m.muted && m.volume > 0;
  const applyMute = (m) => {
    if (muted && !m.muted) {
      m.muted = true;
      mutedByUs.add(m);
    }
  };
  const active = (list) => {
    const present = (m) => (m && list.includes(m) ? m : null);
    return list.find((m) => heard.has(m) && playing(m)) || present(lastHeard) || list.find(playing) || present(lastMedia);
  };
  const sessionState = () => (navigator.mediaSession ? navigator.mediaSession.playbackState : "none");
  const advancePosition = (state) => {
    const playingNow = state === "playing";
    if (playingNow === pagePosition.playing) return;
    const now = Date.now();
    if (pagePosition.playing) pagePosition.position += ((now - pagePosition.at) / 1000) * pagePosition.playbackRate;
    pagePosition.at = now;
    pagePosition.playing = playingNow;
  };
  const positionOf = (m, state) => {
    if (!pagePosition) return isFinite(m.currentTime) ? m.currentTime : 0;
    advancePosition(state);
    const { position, duration, playbackRate, at, playing } = pagePosition;
    const now = position + (playing ? ((Date.now() - at) / 1000) * playbackRate : 0);
    return Math.max(0, duration > 0 ? Math.min(now, duration) : now);
  };
  const movePagePosition = (m, state, to) => {
    if (!pagePosition) return;
    positionOf(m, state);
    pagePosition.position = Math.max(0, pagePosition.duration > 0 ? Math.min(to, pagePosition.duration) : to);
    pagePosition.at = Date.now();
  };
  let queued = false;
  const report = () => {
    queued = false;
    const list = allMedia();
    post("media", { playing: list.some(audible), muted });
    const m = active(list);
    const session = navigator.mediaSession;
    const fromSession = sessionState();
    if (!m || (m.paused && !m.currentTime && fromSession === "none")) return post("nowPlaying", null);
    const meta = session && session.metadata;
    const art = meta && meta.artwork && meta.artwork.length ? meta.artwork[meta.artwork.length - 1].src : null;
    const state = fromSession !== "none" ? fromSession : playing(m) ? "playing" : "paused";
    const duration = pagePosition && pagePosition.duration > 0 ? pagePosition.duration : m.duration;
    post("nowPlaying", {
      title: (meta && meta.title) || document.title || "",
      artist: (meta && meta.artist) || "",
      album: (meta && meta.album) || "",
      artwork: art,
      playbackState: state,
      position: positionOf(m, state),
      duration: isFinite(duration) ? duration : null,
      playbackRate: pagePosition ? pagePosition.playbackRate : m.playbackRate || 1,
      timestamp: Date.now(),
      hasVideo: m.tagName === "VIDEO" && m.videoWidth > 0,
      actions: pageActions,
      controllable: fromSession !== "none" || !(m.duration > 0 && m.duration <= 5),
      loop: !pagePosition && m.loop,
    });
  };
  const schedule = () => {
    if (queued) return;
    queued = true;
    setTimeout(report, 100);
  };
  const listen = (m) => {
    if (listened.has(m)) return;
    listened.add(m);
    for (const type of mediaEvents) m.addEventListener(type, onMedia);
  };
  const track = (m) => {
    listen(m);
    if (detached.has(m)) return;
    if (detached.size >= 8) for (const old of detached) if (!playing(old)) {
      detached.delete(old);
      break;
    }
    detached.add(m);
  };
  const onMedia = (e) => {
    const m = e.target;
    if (!(m instanceof HTMLMediaElement)) return;
    if (!m.isConnected) track(m);
    lastMedia = m;
    if (e.type === "play" || e.type === "playing") {
      applyMute(m);
      listen(m);
    }
    if (e.type === "volumechange") applyMute(m);
    if (audible(m)) {
      heard.add(m);
      lastHeard = m;
    }
    schedule();
  };
  for (const type of mediaEvents) document.addEventListener(type, onMedia, true);
  document.addEventListener(
    "ardia:media-element",
    (e) => {
      const m = e.relatedTarget;
      if (!(m instanceof HTMLMediaElement)) return;
      track(m);
      schedule();
    },
    true,
  );
  const mediaFaultSites = ["netflix.com","disneyplus.com","max.com","hbomax.com","primevideo.com","hulu.com","tv.apple.com","music.apple.com","open.spotify.com","peacocktv.com","paramountplus.com","crunchyroll.com","hotstar.com","jiohotstar.com","v.qq.com","audible.com","audible.co.uk","audible.ca","audible.com.au","audible.de","audible.fr","audible.it","audible.es","audible.co.jp","audible.in","audible.com.br","canalplus.com","mycanal.fr","tv.youtube.com","osnplus.com","anghami.com"];
  if (location.protocol === "https:" && mediaFaultSites.some((site) => location.hostname === site || location.hostname.endsWith("." + site))) {
    let faultsRelayed = 0;
    document.addEventListener(
      "ardia:media-fault",
      (e) => {
        if (typeof e.detail !== "string" || e.detail.length > 64 || ++faultsRelayed > 200) return;
        post("mediaFault", { reason: e.detail });
      },
      true,
    );
  }
  const knownActions = ["play", "pause", "stop", "seekbackward", "seekforward", "seekto", "previoustrack", "nexttrack", "skipad", "enterpictureinpicture"];
  document.addEventListener(
    "ardia:media-session",
    (e) => {
      let data = null;
      try {
        data = typeof e.detail === "string" ? JSON.parse(e.detail) : null;
      } catch (error) {}
      if (!data || typeof data !== "object") return;
      pageActions = Array.isArray(data.actions) ? knownActions.filter((a) => data.actions.includes(a)) : [];
      const p = data.position;
      const finite = (n) => typeof n === "number" && isFinite(n);
      if (!p || !finite(p.position) || !finite(p.duration)) pagePosition = null;
      else {
        const sample = finite(p.id) ? p.id : null;
        if (!pagePosition || sample === null || pagePosition.sample !== sample)
          pagePosition = {
            position: Math.max(0, p.position),
            duration: p.duration,
            playbackRate: finite(p.playbackRate) && p.playbackRate ? p.playbackRate : 1,
            at: finite(p.at) ? p.at : Date.now(),
            sample,
            playing: p.playing === true,
          };
      }
      schedule();
    },
    true,
  );
  if (isTop)
    document.addEventListener(
      "ardia:app-badge",
      (e) => {
        let data = null;
        try {
          data = typeof e.detail === "string" ? JSON.parse(e.detail) : null;
        } catch (error) {}
        if (data && typeof data === "object") post("appBadge", data);
      },
      true,
    );
  const pip = (on) => post("pip", { active: on });
  document.addEventListener("enterpictureinpicture", () => pip(true), true);
  document.addEventListener("leavepictureinpicture", () => pip(false), true);
  document.addEventListener(
    "webkitpresentationmodechanged",
    (e) => e.target instanceof HTMLVideoElement && pip(e.target.webkitPresentationMode === "picture-in-picture"),
    true,
  );
  addEventListener("pagehide", () => {
    if (isTop) return;
    post("media", { playing: false, muted });
    post("nowPlaying", null);
  });
  addEventListener("pageshow", (e) => e.persisted && schedule());

  let hovered = "";
  document.addEventListener(
    "mouseover",
    (e) => {
      const link = e.target && e.target.closest ? e.target.closest("a[href]") : null;
      const href = link ? link.href : "";
      if (href === hovered) return;
      hovered = href;
      post("status", { text: href.slice(0, 8192), y: e.clientY, height: innerHeight });
    },
    true,
  );
  document.addEventListener("mouseleave", () => hovered && post("status", { text: (hovered = "") }), true);

  let sentIcons = "";
  const sendIcons = () => {
    if (!isTop) return;
    const links = Array.from(document.querySelectorAll('link[rel~="icon"], link[rel="shortcut icon"], link[rel~="apple-touch-icon"]'));
    const urls = links.map((l) => l.href).filter((h) => /^(https?|data):/.test(h)).slice(0, 32);
    if (!urls.length && /^https?:$/.test(location.protocol)) urls.push(location.origin + "/favicon.ico");
    const key = urls.join("\n");
    if (!urls.length || key === sentIcons) return;
    const changed = !!sentIcons;
    sentIcons = key;
    post("icons", { urls, changed });
  };
  let iconsQueued = false;
  const queueIcons = () => {
    if (iconsQueued) return;
    iconsQueued = true;
    setTimeout(() => {
      iconsQueued = false;
      sendIcons();
    }, 0);
  };
  const touchesIcon = (records) => {
    for (const r of records) {
      if (r.type === "attributes") {
        if (r.target.nodeName === "LINK") return true;
        continue;
      }
      for (const n of r.addedNodes) if (n.nodeName === "LINK") return true;
      for (const n of r.removedNodes) if (n.nodeName === "LINK") return true;
    }
    return false;
  };
  const watchIcons = () => {
    sendIcons();
    if (!isTop || !document.head) return;
    new MutationObserver((records) => touchesIcon(records) && queueIcons()).observe(document.head, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["href", "rel"],
    });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", watchIcons, { once: true });
  else watchIcons();
  addEventListener("load", sendIcons, { once: true });
  addEventListener("pageshow", (e) => {
    if (!e.persisted) return;
    sentIcons = "";
    sendIcons();
  });

  if (isTop) try {
    const apply = Reflect.apply;
    const { addEventListener: listen, removeEventListener: unlisten } = EventTarget.prototype;
    const raf = window.requestAnimationFrame;
    const send = post;
    const guard = (fn) =>
      function () {
        try {
          return apply(fn, this, arguments);
        } catch (e) {}
      };
    const onReady = (fn) =>
      document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", fn, { once: true }) : fn();
    const parse = (css) => {
      if (!css) return null;
      if (/^rgba?\(/.test(css)) {
        const m = css.match(/[\d.]+/g);
        if (!m || m.length < 3) return null;
        return { r: +m[0], g: +m[1], b: +m[2], a: m[3] === undefined ? 1 : +m[3] };
      }
      const m = css.match(/^(?:color\(([\w-]+)|(lab|lch|oklab|oklch)\()\s*([^/)]*?)\s*(?:\/\s*([\d.]+%?)\s*)?\)$/);
      const toLinearSrgb = m && LINEAR_SRGB_FROM[m[1] ?? m[2]];
      if (!toLinearSrgb) return null;
      const channels = m[3].split(/\s+/).map((token) => (token === "none" ? 0 : parseFloat(token)));
      if (channels.length < 3 || channels.some((n) => !Number.isFinite(n))) return null;
      const [r, g, b] = toLinearSrgb(channels).map((v) => Math.min(255, Math.max(0, srgbFromLinear(v) * 255)));
      const alpha = m[4] === undefined ? 1 : parseFloat(m[4]) / (m[4].endsWith("%") ? 100 : 1);
      return { r, g, b, a: Math.min(1, Math.max(0, alpha)) };
    };
    const srgbFromLinear = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
    const linearFromSrgb = (v) => {
      const magnitude = Math.abs(v);
      return Math.sign(v) * (magnitude <= 0.04045 ? magnitude / 12.92 : ((magnitude + 0.055) / 1.055) ** 2.4);
    };
    const multiply = (matrix, [x, y, z]) => matrix.map(([a, b, c]) => a * x + b * y + c * z);
    const XYZ_D65_TO_LINEAR_SRGB = [
      [3.2409699419045226, -1.537383177570094, -0.4986107602930034],
      [-0.9692436362808796, 1.8759675015077202, 0.04155505740717559],
      [0.05563007969699366, -0.20397695888897652, 1.0569715142428786],
    ];
    const XYZ_D50_TO_D65 = [
      [0.955473421488075, -0.02309845494876471, 0.06325924320057072],
      [-0.0283697093338637, 1.0099953980813041, 0.021041441191917323],
      [0.012314014864481998, -0.020507649298898964, 1.330365926242124],
    ];
    const LINEAR_P3_TO_XYZ_D65 = [
      [0.4865709486482162, 0.26566769316909306, 0.1982172852343625],
      [0.2289745640697488, 0.6917385218365064, 0.079286914093745],
      [0, 0.04511338185890264, 1.043944368900976],
    ];
    const D50_WHITE = [0.3457 / 0.3585, 1, (1 - 0.3457 - 0.3585) / 0.3585];
    const LAB_EPSILON = 216 / 24389;
    const LAB_KAPPA = 24389 / 27;
    const labToLinearSrgb = ([l, a, b]) => {
      const fy = (l + 16) / 116;
      const fx = fy + a / 500;
      const fz = fy - b / 200;
      const xyzD50 = [
        fx ** 3 > LAB_EPSILON ? fx ** 3 : (116 * fx - 16) / LAB_KAPPA,
        l > LAB_KAPPA * LAB_EPSILON ? fy ** 3 : l / LAB_KAPPA,
        fz ** 3 > LAB_EPSILON ? fz ** 3 : (116 * fz - 16) / LAB_KAPPA,
      ].map((v, i) => v * D50_WHITE[i]);
      return multiply(XYZ_D65_TO_LINEAR_SRGB, multiply(XYZ_D50_TO_D65, xyzD50));
    };
    const oklabToLinearSrgb = ([l, a, b]) => {
      const lms = [
        l + 0.3963377774 * a + 0.2158037573 * b,
        l - 0.1055613458 * a - 0.0638541728 * b,
        l - 0.0894841775 * a - 1.291485548 * b,
      ].map((v) => v ** 3);
      return multiply(
        [
          [4.0767416621, -3.3077115913, 0.2309699292],
          [-1.2684380046, 2.6097574011, -0.3413193965],
          [-0.0041960863, -0.7034186147, 1.707614701],
        ],
        lms,
      );
    };
    const fromPolar = ([l, chroma, hue]) => [l, chroma * Math.cos((hue * Math.PI) / 180), chroma * Math.sin((hue * Math.PI) / 180)];
    const LINEAR_SRGB_FROM = {
      srgb: (channels) => channels.slice(0, 3).map(linearFromSrgb),
      "srgb-linear": (channels) => channels.slice(0, 3),
      "display-p3": (channels) => multiply(XYZ_D65_TO_LINEAR_SRGB, multiply(LINEAR_P3_TO_XYZ_D65, channels.slice(0, 3).map(linearFromSrgb))),
      lab: labToLinearSrgb,
      lch: (channels) => labToLinearSrgb(fromPolar(channels)),
      oklab: oklabToLinearSrgb,
      oklch: (channels) => oklabToLinearSrgb(fromPolar(channels)),
    };
    const hex = (c) => "#" + [c.r, c.g, c.b].map((n) => Math.round(n).toString(16).padStart(2, "0")).join("").toUpperCase();
    const normalize = (value) => {
      const probe = document.createElement("span");
      probe.style.color = value;
      if (!probe.style.color) return null;
      document.documentElement.appendChild(probe);
      const c = parse(getComputedStyle(probe).color);
      probe.remove();
      return c && c.a > 0 ? hex(c) : null;
    };
    const setTimer = window.setTimeout;
    const clearTimer = window.clearTimeout;
    const NativeMutationObserver = window.MutationObserver;
    const after = (fn, ms) => apply(setTimer, window, [fn, ms]);
    const nextFrame = (fn) => apply(raf, window, [fn]);
    let metaMedia = [];
    let metaMediaKey = "";
    const watchMetaMedia = (queries, onChange) => {
      const key = queries.join("\n");
      if (key === metaMediaKey) return;
      metaMediaKey = key;
      for (const q of metaMedia) apply(unlisten, q, ["change", onChange]);
      metaMedia = queries.map((media) => matchMedia(media));
      for (const q of metaMedia) apply(listen, q, ["change", onChange]);
    };
    const metaColor = (onMediaChange) => {
      const queries = [];
      let color = null;
      for (const m of document.querySelectorAll('meta[name="theme-color"]')) {
        const media = m.getAttribute("media");
        if (media && !queries.includes(media)) queries.push(media);
        if (!color && (!media || matchMedia(media).matches)) color = normalize(m.getAttribute("content") || "");
      }
      watchMetaMedia(queries, onMediaChange);
      return color;
    };
    const backgroundOf = (el) => el && parse(getComputedStyle(el).backgroundColor);
    const pageBackground = () => {
      for (const el of [document.body, document.documentElement]) {
        const c = backgroundOf(el);
        if (c && c.a > 0) return c;
      }
      const dark = /dark/.test(getComputedStyle(document.documentElement).colorScheme) && matchMedia("(prefers-color-scheme: dark)").matches;
      return dark ? { r: 18, g: 18, b: 18, a: 1 } : { r: 255, g: 255, b: 255, a: 1 };
    };
    const blend = (c, under) =>
      c.a >= 1 ? c : { r: c.r * c.a + under.r * (1 - c.a), g: c.g * c.a + under.g * (1 - c.a), b: c.b * c.a + under.b * (1 - c.a), a: 1 };
    const headerColor = (page) => {
      const scrolled = window.scrollY > 4;
      for (const x of [innerWidth / 2, innerWidth * 0.2, innerWidth * 0.8]) {
        let pinned = false;
        let color = null;
        for (let el = document.elementFromPoint(x, 1); el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
          const cs = getComputedStyle(el);
          if (cs.position === "fixed" || cs.position === "sticky") pinned = true;
          if (!color) {
            const c = parse(cs.backgroundColor);
            if (c && c.a >= 0.5) color = c;
          }
          if (color && pinned) break;
        }
        if (color && (pinned || !scrolled)) return blend(color, page);
      }
      return null;
    };
    const fromHex = (value) => {
      const n = parseInt(value.slice(1, 7), 16);
      return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
    };
    const relativeLuminance = (c) => {
      const linear = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * linear(c.r) + 0.7152 * linear(c.g) + 0.0722 * linear(c.b);
    };
    const clearlyLight = (c) => relativeLuminance(c) >= 0.5;
    const takesLightInk = (c) => {
      const l = relativeLuminance(c) + 0.05;
      return 1.05 / l >= l / 0.05;
    };
    let lastTheme;
    let metaCache;
    let lightMetaOnDarkPage = false;
    const cachedMetaColor = () => (metaCache === undefined ? (metaCache = metaColor(scheduleTheme)) : metaCache);
    const reportTheme = guard(() => {
      if (!document.documentElement) return;
      const meta = cachedMetaColor();
      let color = meta;
      let source = meta ? "meta" : null;
      lightMetaOnDarkPage = false;
      if (document.body && (!meta || clearlyLight(fromHex(meta)))) {
        const page = pageBackground();
        const header = headerColor(page);
        lightMetaOnDarkPage = !!meta && takesLightInk(page);
        if (!meta || (lightMetaOnDarkPage && (!header || takesLightInk(header)))) {
          color = hex(header || page);
          source = header ? "header" : "background";
        }
      }
      const key = color + source;
      if (key === lastTheme) return;
      lastTheme = key;
      send("theme", { color, source });
    });
    let themeQueued = false;
    let pageThemeQueued = false;
    const PAGE_THEME_GAP_MS = 100;
    const themeTouched = (records) => {
      let page = false;
      for (const r of records) {
        if (r.type === "childList") {
          for (const n of r.addedNodes) if (n.nodeName === "META") return "meta";
          for (const n of r.removedNodes) if (n.nodeName === "META") return "meta";
        } else if (r.target.nodeName === "META") return "meta";
        else if ((r.target === document.documentElement || r.target === document.body) && r.oldValue !== r.target.getAttribute(r.attributeName)) page = true;
      }
      return page ? "page" : null;
    };
    const queueTheme = () => {
      if (themeQueued) return;
      themeQueued = true;
      nextFrame(() => {
        themeQueued = false;
        reportTheme();
      });
    };
    const scheduleTheme = () => {
      metaCache = undefined;
      queueTheme();
    };
    const queuePageTheme = () => {
      if (pageThemeQueued) return;
      pageThemeQueued = true;
      after(() => {
        pageThemeQueued = false;
        queueTheme();
      }, PAGE_THEME_GAP_MS);
    };
    const themeChanged = (records) => {
      const touched = themeTouched(records);
      if (touched === "meta") scheduleTheme();
      else if (touched === "page") queuePageTheme();
    };
    const startTheme = () => {
      reportTheme();
      const observer = new NativeMutationObserver(themeChanged);
      observer.observe(document.head || document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["content", "media", "name"],
      });
      for (const el of [document.documentElement, document.body])
        if (el) observer.observe(el, { attributes: true, attributeOldValue: true, attributeFilter: ["class", "style", "data-theme"] });
      for (const ms of [300, 1000, 3000]) after(scheduleTheme, ms);
    };
    onReady(startTheme);
    const resendTheme = () => {
      lastTheme = undefined;
      metaCache = undefined;
      reportTheme();
    };
    addEventListener("pageshow", (e) => e.persisted && resendTheme());
    document.addEventListener("prerenderingchange", resendTheme);
    addEventListener("load", scheduleTheme);
    let scrollSampleQueued = false;
    let scrollSampledAt = -Infinity;
    let scrolledPastTop = false;
    let scrollSettle = 0;
    let scrollSettled = false;
    const sampleScroll = guard((settled) => {
      if (!document.documentElement || (cachedMetaColor() && !lightMetaOnDarkPage)) return;
      const past = window.scrollY > 4;
      const now = performance.now();
      if (!settled && past === scrolledPastTop && now - scrollSampledAt < 150) return;
      scrolledPastTop = past;
      scrollSampledAt = now;
      reportTheme();
    });
    const queueScrollSample = () => {
      if (scrollSampleQueued) return;
      scrollSampleQueued = true;
      nextFrame(() =>
        after(() => {
          scrollSampleQueued = false;
          const settled = scrollSettled;
          scrollSettled = false;
          sampleScroll(settled);
        }, 0),
      );
    };
    const scrollTheme = () => {
      if (metaCache && !lightMetaOnDarkPage) return;
      apply(clearTimer, window, [scrollSettle]);
      scrollSettle = after(() => {
        scrollSettled = true;
        queueScrollSample();
      }, 150);
      queueScrollSample();
    };
    addEventListener("scroll", scrollTheme, { passive: true, capture: true });
    addEventListener("resize", scheduleTheme);
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", scheduleTheme);
  } catch (e) {}

  if (isTop) {
    const scrollDirection = () => {
      const DOWN = 24, UP = 12, MIN_RANGE = 120, SETTLE = 300, GESTURE = 300;
      const paged = (snap, vertical) => {
        const [axis, strictness] = snap.split(" ");
        return strictness === "mandatory" && (axis === "y" || axis === "both" || axis === (vertical ? "inline" : "block"));
      };
      let anchor = 0, last = 0, lastAt = -1e9, settleUntil = -1e9, budget = 0, height = 0, sent = null, gestureSent = false, heading = 0;
      const resized = (viewport, now) => {
        if (now >= settleUntil) budget = 0;
        if (height && viewport !== height) {
          settleUntil = now + SETTLE;
          budget += Math.abs(viewport - height) + 2;
        }
        height = viewport;
      };
      return {
        resized,
        rebase(y) {
          anchor = last = y;
        },
        wheeled(deltaX, deltaY, pinch) {
          if (pinch || !deltaY) {
            if (pinch || deltaX) heading = 0;
            return;
          }
          heading = deltaY > 0 ? 1 : -1;
        },
        undirected() {
          heading = 0;
        },
        scrolled(y, range, viewport, now, user, snap = "", vertical = false) {
          resized(viewport, now);
          if (now - lastAt > GESTURE) {
            gestureSent = false;
            anchor = last;
          }
          lastAt = now;
          const moved = y - last;
          last = y;
          if (budget > 0 && moved) {
            const absorbed = Math.min(budget, Math.abs(moved));
            budget -= absorbed;
            anchor += moved > 0 ? absorbed : -absorbed;
          }
          let state = null;
          if (y <= 2) state = "top";
          else if (!user || moved * heading < 0) anchor = y;
          else if (y - anchor >= DOWN) {
            if (range >= MIN_RANGE && !paged(snap, vertical)) state = "down";
            else anchor = y;
          } else if (anchor - y >= UP) state = "up";
          else if (sent === "down" ? gestureSent && y > anchor : y < anchor) anchor = y;
          if (state) anchor = y;
          if (!state || (state === sent && (state !== "down" || gestureSent))) return null;
          sent = state;
          if (state === "down") gestureSent = true;
          return state;
        },
      };
    };
    const direction = scrollDirection();
    let scroller = null;
    let scrollTarget = null;
    let inputAt = -1e9;
    const noteInput = () => {
      inputAt = performance.now();
      if (!scroller && document.scrollingElement) direction.rebase((scroller = document.scrollingElement).scrollTop);
    };
    const noteUndirectedInput = () => {
      direction.undirected();
      noteInput();
    };
    addEventListener(
      "wheel",
      (e) => {
        direction.wheeled(e.deltaX, e.deltaY, e.ctrlKey);
        noteInput();
      },
      { passive: true, capture: true },
    );
    for (const type of ["keydown", "mousedown", "touchstart"]) addEventListener(type, noteUndirectedInput, { passive: true, capture: true });
    addEventListener("mousemove", (e) => e.buttons && noteUndirectedInput(), { passive: true, capture: true });
    const measureScroll = () => {
      try {
        const target = scrollTarget;
        scrollTarget = null;
        const doc = document.scrollingElement || document.documentElement;
        const el = target === document || target === doc ? doc : target;
        if (!el || !doc || (el !== doc && (el.clientHeight < innerHeight * 0.5 || el.clientWidth < innerWidth * 0.5))) return;
        if (el !== scroller) direction.rebase((scroller = el).scrollTop);
        const now = performance.now();
        const style = getComputedStyle(el === doc ? document.documentElement : el);
        const state = direction.scrolled(el.scrollTop, el.scrollHeight - el.clientHeight, innerHeight, now, now - inputAt < 1000, style.scrollSnapType, /^(vertical|sideways)/.test(style.writingMode));
        if (state) post("scroll", { state });
      } catch (e) {}
    };
    addEventListener(
      "scroll",
      (e) => {
        if (!scrollTarget) requestAnimationFrame(measureScroll);
        scrollTarget = e.target;
      },
      { passive: true, capture: true },
    );
    addEventListener("resize", () => direction.resized(innerHeight, performance.now()));
  }

  {
    const send = post;
    const apply = Reflect.apply;
    const guard = (fn) =>
      function () {
        try {
          return apply(fn, this, arguments);
        } catch (e) {}
      };
    let selectionShown = false;
    let selecting = false;
    const hideSelection = () => {
      if (!selectionShown) return;
      selectionShown = false;
      send("selection", null);
    };
    const editableSelection = (sel) => {
      const active = document.activeElement;
      if (active && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName))) return true;
      const node = sel.anchorNode;
      const el = node && (node.nodeType === 1 ? node : node.parentElement);
      return !!el && el.isContentEditable;
    };
    const reportSelection = guard(() => {
      const sel = getSelection();
      const text = sel && !sel.isCollapsed && sel.rangeCount ? sel.toString().trim() : "";
      const pinched = window.visualViewport && visualViewport.scale !== 1;
      if (!text || pinched || editableSelection(sel)) return hideSelection();
      const r = sel.getRangeAt(0).getBoundingClientRect();
      if (!r.width && !r.height) return hideSelection();
      selectionShown = true;
      send("selection", { text: text.slice(0, 2000), rect: { x: r.left, y: r.top, width: r.width, height: r.height } });
    });
    const selectionListeners = [
      [
        document,
        "mousedown",
        (e) => {
          selecting = e.button === 0;
          hideSelection();
        },
        true,
      ],
      [
        document,
        "mouseup",
        (e) => {
          if (e.button !== 0 || !selecting) return;
          selecting = false;
          setTimeout(reportSelection, 0);
        },
        true,
      ],
      [document, "selectionchange", () => selectionShown && !selecting && getSelection().isCollapsed && hideSelection(), false],
      [document, "keydown", (e) => e.metaKey || /^(Shift|Meta|Alt|Control)$/.test(e.key) || hideSelection(), true],
      [window, "scroll", hideSelection, { passive: true, capture: true }],
      [window, "resize", hideSelection, false],
      [window, "pagehide", hideSelection, false],
    ];
    let selectionListening = false;
    handlers.selectionPopover = (on) => {
      if (!on === !selectionListening) return;
      selectionListening = !!on;
      if (!on) {
        selecting = false;
        hideSelection();
      }
      for (const [target, type, listener, options] of selectionListeners)
        on ? target.addEventListener(type, listener, options) : target.removeEventListener(type, listener, options);
    };
    handlers.selectionPopover(true);

    if (isTop) try {
      const DRAG_MIN = 40;
      const getter = (proto, name) => {
        const get = Object.getOwnPropertyDescriptor(proto, name).get;
        return (o) => apply(get, o, []);
      };
      const target = getter(Event.prototype, "target");
      const nodeType = getter(Node.prototype, "nodeType");
      const parent = getter(Node.prototype, "parentElement");
      const closest = Element.prototype.closest;
      const href = getter(HTMLAnchorElement.prototype, "href");
      const transfer = getter(DragEvent.prototype, "dataTransfer");
      const dropEffect = getter(DataTransfer.prototype, "dropEffect");
      const [clientX, clientY, screenX, screenY] = ["clientX", "clientY", "screenX", "screenY"].map((n) => getter(MouseEvent.prototype, n));
      const width = getter(window, "innerWidth");
      const height = getter(window, "innerHeight");
      const test = RegExp.prototype.test;
      const { hypot } = Math;
      let linkDrag = null;
      document.addEventListener(
        "dragstart",
        guard((e) => {
          linkDrag = null;
          let el = target(e);
          if (!e.isTrusted || !el) return;
          if (nodeType(el) !== 1) el = parent(el);
          const a = el && apply(closest, el, ["a[href]"]);
          const url = a && href(a);
          if (url && apply(test, /^https?:/, [url])) linkDrag = { url, x: screenX(e), y: screenY(e) };
        }),
        true,
      );
      document.addEventListener(
        "dragend",
        guard((e) => {
          const drag = linkDrag;
          linkDrag = null;
          const data = drag && e.isTrusted && transfer(e);
          if (!data || dropEffect(data) !== "none") return;
          const x = clientX(e), y = clientY(e);
          const over = x > 0 && y > 0 && x < width(window) && y < height(window);
          if (over && hypot(screenX(e) - drag.x, screenY(e) - drag.y) >= DRAG_MIN) send("linkDrop", { url: drag.url });
        }),
        true,
      );
    } catch (e) {}
  }

  const guard = (fn) =>
    function () {
      try {
        return Reflect.apply(fn, this, arguments);
      } catch (e) {}
    };
  const later = (fn, ms) => {
    let queued = false;
    return () => {
      if (queued) return;
      queued = true;
      setTimeout(() => {
        queued = false;
        guard(fn)();
      }, ms);
    };
  };
  const onReady = (fn) => (document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", fn, { once: true }) : fn());
  const fieldProviderKit = (env) => {
    const { document, send, guard, later, onReady, revealed, addListener, apply, FrameMutationObserver, setTimeout, addEventListener, requestAnimationFrame, isTop } = env;
    const { charCodeAt, promiseThen, imul, Detector, detect, toRGBA } = env.intrinsics;
    const USERNAME_TOKEN = /(^|\s)(username|email|webauthn)(\s|$)/i;
    const ONE_TIME_CODE = /(^|\s)one-time-code(\s|$)/i;
    const USERNAME_HINT = /user|e-?mail|login|account/i;
    const OTPAUTH_PREFIXES = ["otpauth://", "otpauth-migration://"];
    const hasOwnToggle = (el) => {
      for (let n = el.parentElement, depth = 0; n && depth < 3 && n.querySelectorAll("input").length === 1; n = n.parentElement, depth++)
        for (const c of n.querySelectorAll('button, [role="button"], [aria-label], [title], [class*="eye" i], [class*="toggle" i]'))
          if (c !== el && /show|hide|reveal|toggle|visib|eye|peek|afficher|mostrar|anzeigen/i.test((c.getAttribute("aria-label") || "") + " " + (c.getAttribute("title") || "") + " " + (c.getAttribute("class") || "")))
            return true;
      return false;
    };
    const nearPassword = (el, shown) => {
      let scope = el.form;
      for (let n = el.parentElement, depth = 0; !scope && n && depth < 6; n = n.parentElement, depth++)
        if (n.querySelectorAll("input").length > 1) scope = n;
      return !!scope && (!!scope.querySelector('input[type="password"]') || (!!shown && scope.contains(shown)));
    };
    const loginFieldKind = (el, shown) => {
      if (!el || el.localName !== "input" || el.disabled || el.readOnly || el.hidden || el.type === "hidden") return null;
      if (el.getBoundingClientRect().width < 80) return null;
      const auto = el.getAttribute("autocomplete") || "";
      if (el.type === "password" || el === shown) return "password";
      if (ONE_TIME_CODE.test(auto)) return "code";
      if (el.type === "email" || USERNAME_TOKEN.test(auto)) return "username";
      if (el.type !== "text" && el.type !== "tel") return null;
      const hints = [el.name, el.id, auto, el.getAttribute("placeholder") || ""].join(" ");
      return USERNAME_HINT.test(hints) && nearPassword(el, shown) ? "username" : null;
    };
    const startsWithFolded = (text, prefix) => {
      if (text.length < prefix.length) return false;
      for (let i = 0; i < prefix.length; i++) {
        const code = apply(charCodeAt, text, [i]);
        const folded = code >= 65 && code <= 90 ? code + 32 : code;
        if (folded !== apply(charCodeAt, prefix, [i])) return false;
      }
      return true;
    };
    const verificationSetupURL = (raw) =>
      typeof raw === "string" && raw.length <= 2048 && (startsWithFolded(raw, OTPAUTH_PREFIXES[0]) || startsWithFolded(raw, OTPAUTH_PREFIXES[1])) ? raw : null;

    const SVG_NS = "http://www.w3.org/2000/svg";
    const KEY = [
      ["path", { d: "M5 4.4a3.6 3.6 0 1 0 0 7.2a3.6 3.6 0 1 0 0-7.2ZM4.2 6.9a1.1 1.1 0 1 1 0 2.2a1.1 1.1 0 1 1 0-2.2Z", fill: "currentColor", stroke: "none", "fill-rule": "evenodd" }],
      ["path", { d: "M8 7.1h5.6v1.8H8ZM10.6 8.9h1.5v1.9h-1.5ZM12.4 8.9h1.2v1.4h-1.2Z", fill: "currentColor", stroke: "none" }],
      ["path", { d: "M16.6 7.1l1.9 1.9 1.9-1.9", "stroke-width": "1.4" }],
    ];
    const KEY_BOX = { viewBox: "0 0 22 16", width: "26", height: "19", fill: "none", stroke: "currentColor", "stroke-width": "1.35", "stroke-linecap": "round", "stroke-linejoin": "round" };
    const KEY_CSS =
      "button{all:initial;box-sizing:border-box;display:flex;align-items:center;justify-content:center;border-radius:6px;cursor:default;opacity:1;transition:background-color .12s;background:color-mix(in srgb,currentColor 14%,transparent)}" +
      "button:hover{background:color-mix(in srgb,currentColor 22%,transparent)}button:active{background:color-mix(in srgb,currentColor 30%,transparent)}";
    const ON_DARK = "#ffffff";
    const ON_LIGHT = "#1d1d1f";
    const DARK_LUMINANCE = 0.179;
    const parseColor = (text) => {
      const m = typeof text === "string" ? /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(text) : null;
      if (!m) return null;
      const alpha = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
      return { r: +m[1], g: +m[2], b: +m[3], a: alpha };
    };
    const luminance = ({ r, g, b }) => {
      const linear = (c) => ((c /= 255) <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
      return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
    };
    const readColor = (css) => parseColor(css) || (toRGBA ? toRGBA(css) : null);
    const badgeInk = (backgrounds, text, pageIsDark) => {
      for (const background of backgrounds) {
        const c = readColor(background);
        if (c && c.a >= 0.5) return luminance(c) < DARK_LUMINANCE ? ON_DARK : ON_LIGHT;
      }
      const ink = readColor(text);
      if (ink && ink.a >= 0.5) return luminance(ink) > 0.5 ? ON_DARK : ON_LIGHT;
      return (typeof pageIsDark === "function" ? pageIsDark() : pageIsDark) ? ON_DARK : ON_LIGHT;
    };
    const pageIsDark = () => {
      try {
        const scheme = getComputedStyle(document.documentElement).colorScheme || "";
        const dark = /\bdark\b/.test(scheme), light = /\blight\b/.test(scheme);
        if (dark !== light) return dark;
        const body = document.body ? readColor(getComputedStyle(document.body).color) : null;
        if (body && body.a >= 0.5) return luminance(body) > 0.5;
        return !!(typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches);
      } catch {
        return false;
      }
    };
    const fieldInk = (field, cs) => {
      const backgrounds = [cs.backgroundColor];
      for (let n = field.parentElement, depth = 0; n && depth < 12; n = n.parentElement, depth++) backgrounds.push(getComputedStyle(n).backgroundColor);
      return badgeInk(backgrounds, cs.color, pageIsDark);
    };
    const KEY_ASPECT = 1.4;
    const HINT_GAP = 8;
    const HINT_HEIGHT = 28;
    const HINT_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
    const HINT_CSS =
      ".chip{all:initial;box-sizing:border-box;display:flex;align-items:center;gap:6px;padding:5px 5px 5px 10px;border-radius:8px;background:#1f2328;color:#f0f6fc;border:1px solid rgba(255,255,255,.14);font:500 12.5px/18px -apple-system,BlinkMacSystemFont,system-ui,sans-serif;white-space:nowrap;box-shadow:0 6px 18px rgba(0,0,0,.35);pointer-events:none}" +
      "b{font-weight:650;background:rgba(255,255,255,.14);padding:0 6px;border-radius:5px}" +
      "button{all:initial;pointer-events:auto;cursor:default;width:18px;height:18px;border-radius:5px;display:flex;align-items:center;justify-content:center;color:#9198a1;font:15px/1 -apple-system,system-ui,sans-serif}button:hover{background:rgba(255,255,255,.12);color:#f0f6fc}";
    const KEY_REPEAT_MS = 600;
    const QR_MIN = 64;
    const QR_MAX = 640;
    const QR_DETECTIONS = 12;
    const QR_CANVAS_SCANS = 3;
    const QR_CANVAS_RETRY_MS = 1500;
    const LINKS_PER_SCAN = 8;
    const FRAME_DEPTH = 4;

    let config = null;
    let listening = false;
    let keyField = null;
    let keyKind = null;
    let keyHost = null;
    let hintHost = null;
    let hintText = null;
    let hintClose = null;
    let hintField = null;
    let hintSide = "below";
    let hintLabel = "";
    let keyButton = null;
    let keyClickedAt = -Infinity;
    let reportedFocus;
    let focusSeq = 0;
    let observer = null;
    let qrDetector = null;
    let qrDetections = 0;
    let qrChecked = new WeakMap();
    let qrCanvasScans = new WeakMap();
    let found = new Set();
    const typed = new WeakSet();
    const watchedDocuments = new WeakSet();

    const findsCodes = () => !!config && config.codeSetup && isTop;
    const wants = (kind) => !!config && (kind === "code" ? config.oneTimeCode : kind ? config.login : false);
    const svgElement = (tag, attributes) => {
      const el = document.createElementNS(SVG_NS, tag);
      for (const name of Object.keys(attributes)) el.setAttribute(name, attributes[name]);
      return el;
    };
    const trailingRect = (field) => {
      const r = field.getBoundingClientRect();
      const cs = getComputedStyle(field);
      const size = Math.min(24, Math.max(18, r.height - 8));
      const width = Math.round(size * KEY_ASPECT);
      const rtl = cs.direction === "rtl";
      const inset = Math.max(4, Math.min(10, parseFloat(rtl ? cs.paddingLeft : cs.paddingRight) || 4));
      const border = parseFloat(rtl ? cs.borderLeftWidth : cs.borderRightWidth) || 0;
      return { left: rtl ? r.left + border + inset : r.right - border - inset - width, top: r.top + (r.height - size) / 2, size, width, color: fieldInk(field, cs) };
    };
    const hideHint = () => {
      if (hintHost) hintHost.style.display = "none";
      hintField = null;
    };
    const hideKey = () => {
      if (keyHost) keyHost.style.display = "none";
      keyField = keyKind = null;
      hideHint();
    };
    const placeHint = () => {
      if (!hintHost || !hintField || hintField !== keyField) return;
      const { left, top, size, width } = (env.keyRect || trailingRect)(keyField);
      const height = (hintHost.getBoundingClientRect && hintHost.getBoundingClientRect().height) || HINT_HEIGHT;
      const hintWidth = (hintHost.getBoundingClientRect && hintHost.getBoundingClientRect().width) || 0;
      hintHost.style.left = Math.max(4, left + width - hintWidth) + "px";
      hintHost.style.top = (hintSide === "above" ? Math.max(4, top - HINT_GAP - height) : top + size + HINT_GAP) + "px";
    };
    const makeHint = () => {
      if (env.makeHint) return env.makeHint();
      const host = document.createElement("ardia-field-provider-hint");
      host.style.cssText = "all:initial;position:fixed;z-index:2147483647;display:none;";
      const root = host.attachShadow({ mode: "closed" });
      const style = document.createElement("style");
      style.textContent = HINT_CSS;
      root.appendChild(style);
      const chip = document.createElement("div");
      chip.className = "chip";
      const text = document.createElement("span");
      const close = document.createElement("button");
      close.type = "button";
      close.tabIndex = -1;
      close.textContent = "\u00d7";
      chip.appendChild(text);
      chip.appendChild(close);
      root.appendChild(chip);
      return { host, text, close };
    };
    const showHint = (state) => {
      const label = state && typeof state.label === "string" ? state.label : "";
      if (!config || !keyField || !keyHost || keyHost.style.display !== "block" || !HINT_LABEL.test(label)) return hideHint();
      if (!hintHost || !hintHost.isConnected) {
        ({ host: hintHost, text: hintText, close: hintClose } = makeHint());
        hintClose.setAttribute("aria-label", "Close");
        apply(addListener, hintClose, ["mousedown", (e) => e.preventDefault()]);
        apply(addListener, hintClose, [
          "click",
          guard((e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!e.isTrusted || !hintField) return;
            hideHint();
            send("fieldProviderHint", { state: "dismissed" });
          }),
        ]);
        document.documentElement.appendChild(hintHost);
      }
      const side = state.side === "above" ? "above" : "below";
      if (hintField === keyField && hintHost.style.display === "block" && hintLabel === label && hintSide === side) return placeHint();
      hintLabel = label;
      const bold = document.createElement("b");
      bold.textContent = label;
      hintText.replaceChildren("Type ", bold, " in Passwords to find this site");
      hintSide = side;
      hintField = keyField;
      hintHost.style.display = "block";
      placeHint();
      send("fieldProviderHint", { state: "shown" });
    };
    const placeKey = () => {
      if (!keyHost || !keyField) return;
      const { left, top, size, width, color } = (env.keyRect || trailingRect)(keyField);
      keyHost.style.left = left + "px";
      keyHost.style.top = top + "px";
      keyButton.style.width = width + "px";
      keyButton.style.height = size + "px";
      keyButton.style.color = color;
    };
    const makeKey = () => {
      if (env.makeKey) return env.makeKey();
      const host = document.createElement("ardia-field-provider");
      host.style.cssText = "all:initial;position:fixed;z-index:2147483647;display:none;";
      const root = host.attachShadow({ mode: "closed" });
      const style = document.createElement("style");
      style.textContent = KEY_CSS;
      root.appendChild(style);
      const button = document.createElement("button");
      button.type = "button";
      button.tabIndex = -1;
      const svg = svgElement("svg", KEY_BOX);
      for (const [tag, attributes] of KEY) svg.appendChild(svgElement(tag, attributes));
      button.appendChild(svg);
      root.appendChild(button);
      return { host, button };
    };
    const ensureKey = () => {
      if (keyHost && keyHost.isConnected) return;
      ({ host: keyHost, button: keyButton } = makeKey());
      keyButton.title = "Passwords";
      keyButton.setAttribute("aria-label", "Fill from Passwords");
      apply(addListener, keyButton, ["mousedown", (e) => e.preventDefault()]);
      apply(addListener, keyButton, [
        "click",
        guard((e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!e.isTrusted || !config || !keyKind || !keyField || !wants(keyKind)) return;
          const box = (env.keyRect || trailingRect)(keyField);
          if (!(e.clientX >= box.left - 2 && e.clientX <= box.left + box.width + 2 && e.clientY >= box.top - 2 && e.clientY <= box.top + box.size + 2)) return;
          if (e.timeStamp - keyClickedAt < KEY_REPEAT_MS) return;
          keyClickedAt = e.timeStamp;
          send("fieldProvider", { field: keyKind, generation: config.generation });
        }),
      ]);
      document.documentElement.appendChild(keyHost);
    };
    const updateKey = guard(() => {
      if (!config) return hideKey();
      const el = document.activeElement;
      const kind = loginFieldKind(el, revealed());
      if (!kind || !wants(kind)) return hideKey();
      if (el.value && typed.has(el)) return hideKey();
      if (kind === "password" && keyField !== el && hasOwnToggle(el)) return hideKey();
      ensureKey();
      keyField = el;
      keyKind = kind;
      keyHost.style.display = "block";
      if (hintField && hintField !== el) hideHint();
      placeKey();
      placeHint();
    });

    const watchDocument = (doc) => {
      if (watchedDocuments.has(doc)) return;
      watchedDocuments.add(doc);
      apply(addListener, doc, ["focusin", focusGained, true]);
      apply(addListener, doc, ["focusout", focusLost, true]);
    };
    const deepActive = (doc, depth) => {
      const el = doc.activeElement;
      if (!el || (el.localName !== "iframe" && el.localName !== "frame") || depth >= FRAME_DEPTH) return el;
      let inner = null;
      try {
        inner = el.contentDocument;
      } catch {}
      if (!inner) return null;
      watchDocument(inner);
      return deepActive(inner, depth + 1);
    };
    const sendFocus = (field, query) => {
      reportedFocus = field;
      focusSeq++;
      send("fieldFocus", query ? { field, seq: focusSeq, generation: config.generation, query } : { field, seq: focusSeq, generation: config.generation });
    };
    const reportFocus = guard(() => {
      if (!isTop || !config) return;
      const kind = loginFieldKind(deepActive(document, 0), revealed());
      const field = wants(kind) ? kind : null;
      if (field !== reportedFocus) sendFocus(field);
    });
    const reportFocusSoon = () => setTimeout(reportFocus, 0);
    const focusQuery = guard((query) => {
      if (!isTop || !config || typeof query !== "string" || !query || query.length > 64) return;
      const kind = loginFieldKind(deepActive(document, 0), revealed());
      sendFocus(wants(kind) ? kind : null, query);
    });
    const focusGained = () => {
      reportFocus();
      reportFocusSoon();
    };
    const focusLost = guard(() => {
      if (isTop && config && reportedFocus !== null) sendFocus(null);
      reportFocusSoon();
    });
    const codeKey = (url) => {
      let hash = 0x811c9dc5;
      for (let i = 0; i < url.length; i++) hash = imul(hash ^ apply(charCodeAt, url, [i]), 0x01000193);
      return (hash >>> 0).toString(16) + ":" + url.length.toString(36);
    };

    const noteInput = guard((e) => {
      const el = e.target;
      if (!el || el.localName !== "input") return;
      if (!el.value) typed.delete(el);
      else if (e.isTrusted) typed.add(el);
      if (config) updateKey();
    });
    const qrCandidate = (el) => {
      if (el.localName === "img" && !el.complete) return "later";
      if (el.localName === "img" ? el.naturalWidth < QR_MIN : el.localName !== "canvas") return "never";
      const r = el.getBoundingClientRect();
      if (r.width < QR_MIN || r.height < QR_MIN || r.width > QR_MAX || r.height > QR_MAX) return "later";
      const ratio = r.width / r.height;
      if (ratio < 0.8 || ratio > 1.25) return "later";
      return !el.checkVisibility || el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) ? "yes" : "later";
    };
    const forgetFound = () => {
      found = new Set();
      qrChecked = new WeakMap();
      qrCanvasScans = new WeakMap();
      qrDetections = 0;
    };
    const noteCode = (raw, generation) => {
      const url = verificationSetupURL(raw);
      if (!url || !findsCodes() || config.generation !== generation) return false;
      const key = codeKey(url);
      if (found.has(key)) return true;
      found.add(key);
      send("verificationCode", { url, generation });
      return true;
    };
    const scanLinks = guard(() => {
      if (!findsCodes()) return;
      let seen = 0;
      for (const link of document.querySelectorAll('a[href^="otpauth" i]')) {
        if (++seen > LINKS_PER_SCAN) return;
        noteCode(link.getAttribute("href"), config.generation);
      }
    });
    const scanQR = guard(() => {
      if (!findsCodes() || !Detector || document.visibilityState !== "visible" || !document.querySelector("input")) return;
      const generation = config.generation;
      for (const el of document.querySelectorAll("img, canvas")) {
        if (qrDetections >= QR_DETECTIONS) return;
        const canvas = el.localName === "canvas";
        const src = el.currentSrc || el.src || "";
        if (canvas ? (qrCanvasScans.get(el) ?? 0) >= QR_CANVAS_SCANS : qrChecked.get(el) === src) continue;
        const candidate = qrCandidate(el);
        if (!canvas && candidate !== "later") qrChecked.set(el, src);
        if (candidate !== "yes") continue;
        qrDetections++;
        if (canvas) qrCanvasScans.set(el, (qrCanvasScans.get(el) ?? 0) + 1);
        if (!qrDetector) qrDetector = new Detector({ formats: ["qr_code"] });
        const scans = qrCanvasScans;
        apply(promiseThen, apply(detect, qrDetector, [el]), [
          guard((codes) => {
            let accepted = false;
            for (let i = 0; i < codes.length; i++) if (noteCode(codes[i] && codes[i].rawValue, generation)) accepted = true;
            if (canvas && accepted) scans.set(el, QR_CANVAS_SCANS);
            else if (canvas && scans.get(el) < QR_CANVAS_SCANS) setTimeout(scanSoon, QR_CANVAS_RETRY_MS);
          }),
          () => {},
        ]);
      }
    });
    const scan = () => {
      scanLinks();
      scanQR();
    };
    const scanSoon = later(scan, 400);
    const listen = () => {
      if (listening) return;
      listening = true;
      watchDocument(document);
      document.addEventListener("focusin", updateKey, true);
      document.addEventListener("focusin", () => findsCodes() && scanSoon(), true);
      document.addEventListener(
        "focusout",
        guard((e) => {
          setTimeout(() => document.activeElement !== e.target && updateKey(), 0);
        }),
        true,
      );
      document.addEventListener("input", noteInput, true);
      document.addEventListener("load", (e) => findsCodes() && e.target && e.target.localName === "img" && scanSoon(), true);
      document.addEventListener("visibilitychange", () => findsCodes() && scanSoon());
      addEventListener("pageshow", (e) => e.isTrusted && e.persisted && forgetFound());
      addEventListener("focus", focusGained, true);
      addEventListener("blur", focusLost, true);
      addEventListener("scroll", () => keyField && requestAnimationFrame(() => (placeKey(), placeHint())), { passive: true, capture: true });
      addEventListener("resize", () => keyField && requestAnimationFrame(() => (placeKey(), placeHint())));
      addEventListener("pagehide", hideHint);
    };
    const stopScanning = () => {
      if (observer) observer.disconnect();
      observer = null;
    };
    const configure = (state) => {
      const next =
        state && typeof state === "object"
          ? { login: state.login === true, oneTimeCode: state.oneTimeCode === true, codeSetup: state.codeSetup === true, generation: typeof state.generation === "number" ? state.generation : 0 }
          : null;
      const previous = config;
      config = next && (next.login || next.oneTimeCode || next.codeSetup) ? next : null;
      if (!config) {
        hideKey();
        stopScanning();
        found = new Set();
        reportedFocus = undefined;
        return;
      }
      if (!previous || previous.generation !== config.generation) {
        found = new Set();
        qrChecked = new WeakMap();
        qrCanvasScans = new WeakMap();
        qrDetections = 0;
        reportedFocus = undefined;
      }
      listen();
      if (!findsCodes()) stopScanning();
      else {
        if (!observer && FrameMutationObserver) {
          observer = new FrameMutationObserver(scanSoon);
          observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["src", "href", "class", "style", "hidden"] });
        }
        onReady(scan);
      }
      updateKey();
      reportedFocus = undefined;
      reportFocus();
    };
    return { configure, focusQuery, hint: guard((state) => (state ? showHint(state) : hideHint())), badgeInk, hasOwnToggle, loginFieldKind, verificationSetupURL, codeKey, rememberedCodes: () => found.size };
  };
  const fieldProviderIntrinsics = (scope) => {
    const call = Reflect.apply;
    const describe = Object.getOwnPropertyDescriptor;
    const accessor = (proto, name, kind) => (proto && describe(proto, name) ? describe(proto, name)[kind] : undefined);
    const Offscreen = scope.OffscreenCanvas;
    const pen = scope.OffscreenCanvasRenderingContext2D && scope.OffscreenCanvasRenderingContext2D.prototype;
    const getContext = Offscreen && Offscreen.prototype.getContext;
    const setFill = accessor(pen, "fillStyle", "set");
    const clearRect = pen && pen.clearRect;
    const fillRect = pen && pen.fillRect;
    const getImageData = pen && pen.getImageData;
    const pixelBytes = accessor(scope.ImageData && scope.ImageData.prototype, "data", "get");
    const painted = !!(Offscreen && getContext && setFill && clearRect && fillRect && getImageData && pixelBytes);
    let context = null;
    const toRGBA = (css) => {
      if (!painted || typeof css !== "string" || !css || css.length > 200) return null;
      try {
        if (!context) context = call(getContext, new Offscreen(1, 1), ["2d", { willReadFrequently: true }]);
        call(clearRect, context, [0, 0, 1, 1]);
        call(setFill, context, ["rgba(0, 0, 0, 0)"]);
        call(setFill, context, [css]);
        call(fillRect, context, [0, 0, 1, 1]);
        const bytes = call(pixelBytes, call(getImageData, context, [0, 0, 1, 1]), []);
        return { r: bytes[0], g: bytes[1], b: bytes[2], a: bytes[3] / 255 };
      } catch {
        return null;
      }
    };
    const Detector = typeof scope.BarcodeDetector === "function" ? scope.BarcodeDetector : null;
    const detect = Detector && Detector.prototype ? Detector.prototype.detect : null;
    return {
      charCodeAt: String.prototype.charCodeAt,
      promiseThen: Promise.prototype.then,
      imul: Math.imul,
      Detector: typeof detect === "function" ? Detector : null,
      detect,
      toRGBA,
    };
  };

  const fieldProviders = fieldProviderKit({
    document,
    send: post,
    guard,
    later,
    onReady,
    revealed: () => null,
    addListener: EventTarget.prototype.addEventListener,
    apply: Reflect.apply,
    FrameMutationObserver: window.MutationObserver,
    setTimeout,
    addEventListener,
    requestAnimationFrame,
    isTop,
    intrinsics: fieldProviderIntrinsics(window),
  });
  post("fieldProviderHello", null);
  addEventListener("pageshow", (e) => e.isTrusted && e.persisted && post("fieldProviderHello", null));

  window.__ardia = {
    fieldProvider(state) {
      fieldProviders.configure(state);
    },
    fieldFocusQuery(query) {
      fieldProviders.focusQuery(query);
    },
    fieldProviderHint(state) {
      fieldProviders.hint(state);
    },
    mute(on) {
      muted = !!on;
      for (const m of allMedia()) {
        if (muted) applyMute(m);
        else if (mutedByUs.has(m)) {
          m.muted = false;
          mutedByUs.delete(m);
        }
      }
      report();
    },
    media(action, seconds) {
      const m = active(allMedia());
      const call = (name, details) =>
        pageActions.includes(name) &&
        !document.dispatchEvent(new CustomEvent("ardia:media-action", { cancelable: true, detail: JSON.stringify({ action: name, ...details }) }));
      const isPlaying = sessionState() === "playing" || (!!m && playing(m));
      if (action === "play") call("play") || (m && m.play());
      else if (action === "pause") call("pause") || (m && m.pause());
      else if (action === "stop") call("stop") || (m && m.pause());
      else if (action === "toggle") isPlaying ? call("pause") || (m && m.pause()) : call("play") || (m && m.play());
      else if (action === "next") call("nexttrack");
      else if (action === "previous") call("previoustrack");
      else if (action === "seekBy") {
        const handled = seconds >= 0 ? call("seekforward", { seekOffset: seconds }) : call("seekbackward", { seekOffset: -seconds });
        if (!handled && m) {
          const state = isPlaying ? "playing" : "paused";
          const from = pagePosition ? positionOf(m, state) : m.currentTime;
          m.currentTime = Math.max(0, Math.min(m.duration || Infinity, m.currentTime + seconds));
          movePagePosition(m, state, from + seconds);
        }
      } else if (action === "seekTo" && !call("seekto", { seekTime: seconds }) && m) {
        m.currentTime = Math.max(0, seconds);
        movePagePosition(m, isPlaying ? "playing" : "paused", seconds);
      }
      schedule();
      return !!m || pageActions.length > 0;
    },
    pictureInPicture(on, automatic) {
      if (!on) {
        if (document.pictureInPictureElement) document.exitPictureInPicture();
        for (const v of document.querySelectorAll("video")) if (v.webkitPresentationMode === "picture-in-picture") v.webkitSetPresentationMode("inline");
        return true;
      }
      const videos = Array.from(document.querySelectorAll("video"));
      const largest = () => videos.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
      const v = videos.find(playing) || (automatic ? null : largest());
      if (!v) return automatic ? "nothingPlaying" : false;
      if (v.webkitSupportsPresentationMode && v.webkitSupportsPresentationMode("picture-in-picture")) v.webkitSetPresentationMode("picture-in-picture");
      else if (v.requestPictureInPicture) v.requestPictureInPicture();
      else return false;
      return true;
    },
    selectionPopover(on) {
      if (handlers.selectionPopover) handlers.selectionPopover(on);
    },
    count(text) {
      if (!text || !document.body) return 0;
      const haystack = document.body.innerText.toLowerCase();
      const needle = text.toLowerCase();
      let n = 0;
      for (let at = haystack.indexOf(needle); at >= 0 && n < 1000; at = haystack.indexOf(needle, at + needle.length)) n++;
      return n;
    },
  };
})();
