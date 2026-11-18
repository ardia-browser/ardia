(function (post) {
  "use strict";
  const web = /^(https?|file):$/.test(location.protocol);
  const sameOriginChild = location.protocol === "about:" && window !== window.top && /^https?:\/\//.test(self.origin);
  if (!web && !sameOriginChild) return () => {};
  const isTop = window === window.top;
  const handlers = Object.create(null);
  const { stringify: toJSON, parse: fromJSON } = JSON;
  const apply = Reflect.apply;
  const asNative = (native, call) => {
    const { getPrototypeOf: protoOf, setPrototypeOf: setProtoOf } = Reflect;
    const disguised = new Proxy(native, {
      apply: (target, self, args) => call(target, self, args),
      setPrototypeOf(target, next) {
        for (let link = next; link !== null; link = protoOf(link))
          if (link === disguised || link === target) throw new TypeError("Cyclic __proto__ value");
        return setProtoOf(target, next);
      },
    });
    return disguised;
  };
  const { keys, setPrototypeOf } = Object;
  const { isArray } = Array;
  const { isFinite } = Number;
  const plain = (value, depth) => {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") return isFinite(value) ? value : null;
    if (typeof value !== "object" || depth > 4) return null;
    const out = setPrototypeOf(isArray(value) ? [] : {}, null);
    const names = keys(value);
    for (let i = 0; i < names.length; i++) {
      const v = value[names[i]];
      if (v !== undefined && typeof v !== "function") out[names[i]] = plain(v, depth + 1);
    }
    return out;
  };
  const serialize = (data) => toJSON(plain(data, 0));
  const send = (kind, data) => post(kind, serialize(data));
  const onReady = (fn) =>
    document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", fn, { once: true }) : fn();
  const guard = (fn) =>
    function () {
      try {
        return apply(fn, this, arguments);
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

  const displayRequests = new Map();
  let displaySeq = 0;
  let displayMediaShim = null;
  let nativeGetDisplayMedia = null;
  const restoreDisplayMedia = () => {
    const devices = navigator.mediaDevices;
    const proto = devices && Object.getPrototypeOf(devices);
    if (!proto || !displayMediaShim || proto.getDisplayMedia !== displayMediaShim) return;
    proto.getDisplayMedia = nativeGetDisplayMedia;
    displayMediaShim = null;
  };
  const installDisplayMedia = () => {
    const devices = navigator.mediaDevices;
    const proto = devices && Object.getPrototypeOf(devices);
    if (!proto || !proto.getDisplayMedia || displayMediaShim) return;
    nativeGetDisplayMedia = proto.getDisplayMedia;
    const getUserMedia = proto.getUserMedia;
    const activation = navigator.userActivation;
    const activationProto = activation && Object.getPrototypeOf(activation);
    const activationState = activationProto && Object.getOwnPropertyDescriptor(activationProto, "isActive");
    const isActive = activationState && activationState.get;
    const policy = document.featurePolicy;
    const allowsFeature = policy && policy.allowsFeature;
    const nativeRejects = (self, options) =>
      self !== devices ||
      (options !== undefined && options !== null && typeof options !== "object" && typeof options !== "function") ||
      (policy && allowsFeature && !apply(allowsFeature, policy, ["display-capture"]));
    displayMediaShim = asNative(nativeGetDisplayMedia, (target, self, args) => {
      const constraints = args[0];
      if (nativeRejects(self, constraints)) return apply(target, self, args);
      if (activation && isActive && !apply(isActive, activation, []))
        return Promise.reject(new DOMException("getDisplayMedia() requires transient activation (user gesture).", "InvalidStateError"));
      return new Promise((resolve, reject) => {
        const id = ++displaySeq;
        const options = constraints || {};
        displayRequests.set(id, { self, resolve, reject, constraints: options });
        const windowAudio = options.windowAudio === "exclude" || options.windowAudio === "window" ? options.windowAudio : "system";
        send("displayMedia", { id, audio: !!options.audio, systemAudio: options.systemAudio !== "exclude", windowAudio });
      });
    });
    proto.getDisplayMedia = displayMediaShim;
    handlers.displayMedia = ({ id, sourceId, audio }) => {
      const request = displayRequests.get(id);
      if (!request) return;
      displayRequests.delete(id);
      if (!sourceId) {
        request.reject(new DOMException("Permission denied", "NotAllowedError"));
        return;
      }
      const video = request.constraints.video;
      const frameRate = (video && video.frameRate && (video.frameRate.max || video.frameRate.ideal || video.frameRate)) || 30;
      apply(getUserMedia, request.self, [
        {
          audio: audio === true ? { mandatory: { chromeMediaSource: "desktop" } } : false,
          video: { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: sourceId, maxWidth: 3840, maxHeight: 2160, maxFrameRate: +frameRate || 30 } },
        },
      ]).then(request.resolve, request.reject);
    };
  };
  installDisplayMedia();

  const receive = (kind, json) => {
    const handler = handlers[kind];
    if (handler) guard(handler)(fromJSON(json));
  };
  if (!web) {
    const configureDisplayMedia = (config) => (config.displayMediaPicker ? installDisplayMedia() : restoreDisplayMedia());
    handlers.config = configureDisplayMedia;
    send("displayMediaHello", {});
    return receive;
  }

  const frame = Math.random().toString(36).slice(2);
  const tracked = new WeakSet();
  let active = null;
  let lastHeard = null;
  const heard = new WeakSet();

  const session = navigator.mediaSession;
  const actions = new Map();
  let positionState = null;
  let timeline = null;
  const listening = new WeakSet();
  const LISTEN_TRIES = 20;
  const playingUnmuted = (m) => !m.paused && !m.ended && !m.muted && m.volume > 0;
  const decodedAudio = (m) =>
    m.srcObject instanceof MediaStream
      ? m.srcObject.getAudioTracks().length > 0
      : typeof m.webkitAudioDecodedByteCount !== "number" || m.webkitAudioDecodedByteCount > 0;
  const listenFor = (m, tries) => {
    if (heard.has(m) || !playingUnmuted(m)) return listening.delete(m);
    if (decodedAudio(m)) {
      heard.add(m);
      lastHeard = m;
      listening.delete(m);
      return reportNowPlaying();
    }
    if (tries >= LISTEN_TRIES) return listening.delete(m);
    setTimeout(guard(() => listenFor(m, tries + 1)), 500);
  };
  const noteHeard = (m) => {
    if (heard.has(m) || listening.has(m) || !playingUnmuted(m)) return;
    listening.add(m);
    listenFor(m, 0);
  };
  const isPlaying = (m) => !m.paused && !m.ended;
  const askSiteToMatch = guard((paused) => {
    const action = paused ? "pause" : "play";
    actions.get(action)?.({ action });
  });
  const pickMedia = () => {
    const all = [...document.querySelectorAll("video,audio")];
    for (const m of [active, lastHeard]) if (m && !all.includes(m) && tracked.has(m)) all.push(m);
    const current = all.includes(active) ? active : null;
    const heardBefore = all.includes(lastHeard) ? lastHeard : null;
    return (
      all.find((m) => heard.has(m) && isPlaying(m)) ||
      (current && heard.has(current) ? current : null) ||
      all.find(isPlaying) ||
      heardBefore ||
      current
    );
  };
  const oneShot = (m) => m.duration > 0 && m.duration <= 5;
  const absolute = (src) => {
    try {
      return new URL(src, location.href).href;
    } catch {
      return null;
    }
  };
  const artworkOf = (metadata) => {
    const art = metadata && metadata.artwork;
    if (!art || !art.length) return null;
    const size = (a) => Math.max(0, ...String(a.sizes || "0x0").split(/\s+/).map((s) => parseInt(s, 10) || 0));
    return absolute([...art].sort((a, b) => size(b) - size(a))[0].src);
  };
  const NOW_PLAYING_DRIFT_S = 1;
  let lastNowPlaying = null;
  let reportedMedia = null;
  const projectedPosition = (last, now) => last.position + (last.playing ? ((now - last.at) / 1000) * last.rate : 0);
  const reportNowPlaying = later(() => {
    const el = pickMedia();
    reportedMedia = el;
    const md = session && session.metadata;
    let state = null;
    if (el || md) {
      const duration = positionState?.duration ?? el?.duration;
      const sessionState = session ? session.playbackState : "none";
      const onTimeline = timeline && timelineReport(timeline, el, performance.now());
      state = {
        frame,
        title: md?.title || document.title || "",
        artist: md?.artist || "",
        album: md?.album || "",
        artwork: artworkOf(md),
        playbackState: sessionState !== "none" ? sessionState : el ? (el.paused || el.ended ? "paused" : "playing") : "none",
        position: onTimeline ? onTimeline.position : (el?.currentTime ?? 0),
        duration: Number.isFinite(duration) ? duration : null,
        playbackRate: onTimeline ? onTimeline.playbackRate : (el?.playbackRate ?? 1),
        hasVideo: !!el && el.tagName === "VIDEO" && el.videoWidth > 0,
        actions: [...actions.keys()],
        controllable: !!el && heard.has(el) && (sessionState !== "none" || !oneShot(el)),
        loop: !positionState && !!el && el.loop,
      };
      if (!state.title && !el) state = null;
    }
    const now = Date.now();
    const key = serialize(state && { ...state, position: 0 });
    const last = lastNowPlaying;
    if (last && key === last.key && (!state || Math.abs(state.position - projectedPosition(last, now)) < NOW_PLAYING_DRIFT_S)) return;
    lastNowPlaying = { key, position: state ? state.position : 0, at: now, playing: !!state && state.playbackState === "playing", rate: (state && state.playbackRate) || 1 };
    send("nowPlaying", state && { ...state, timestamp: now });
  }, 100);
  let blockAutoplay = false;
  let usedHere = false;
  const noteUse = (e) => {
    if (e.isTrusted && !(e.type === "keydown" && (e.key === "Escape" || e.metaKey))) usedHere = true;
  };
  for (const type of ["pointerdown", "keydown"]) window.addEventListener(type, noteUse, true);
  const askedToPlay = () => usedHere || (!isTop && !!(navigator.userActivation && navigator.userActivation.isActive));
  let pipTrace = false;
  let pipHandlerSet = null;
  const playingMedia = new Set();
  const onMediaEvent = (e) => {
    const m = e.target;
    if (!(m instanceof HTMLMediaElement)) return;
    if (e.type === "play" || e.type === "playing") playingMedia.add(m);
    else if (e.type === "pause" || e.type === "ended" || e.type === "emptied") playingMedia.delete(m);
    if (blockAutoplay && e.type === "play" && !askedToPlay()) {
      m.pause();
      return;
    }
    if (e.type === "emptied") timeline?.mediaTimes.delete(m);
    if (e.type === "play" || e.type === "playing") {
      active = m;
      watchRemoval(m);
      const joinedAt = timeline && anchorStartedMedia(timeline, m, reportedMedia, performance.now());
      if (joinedAt != null) restartTimelineClock(joinedAt);
    }
    noteHeard(m);
    if (e.type !== "volumechange") reportNowPlaying();
  };
  const watched = new WeakSet();
  const watchRemoval = (m) => {
    if (watched.has(m)) return;
    watched.add(m);
    m.addEventListener("pause", () => {
      if (m.isConnected || tracked.has(m)) return;
      reportNowPlaying();
    });
  };
  const mediaEvents = ["play", "playing", "pause", "ended", "volumechange", "emptied", "seeked", "ratechange", "loadedmetadata"];
  for (const e of mediaEvents) document.addEventListener(e, onMediaEvent, true);
  const detachedMediaWatchers = [];
  const play = HTMLMediaElement.prototype.play;
  const pausedState = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "paused").get;
  const connectedState = Object.getOwnPropertyDescriptor(Node.prototype, "isConnected").get;
  const trackDetachedMedia = (self) => {
    let media = false;
    try {
      apply(pausedState, self, []);
      media = true;
    } catch (e) {}
    if (media && !tracked.has(self) && !apply(connectedState, self, [])) {
      tracked.add(self);
      for (const e of mediaEvents) self.addEventListener(e, onMediaEvent);
      for (const watch of detachedMediaWatchers) guard(watch)(self);
    }
    return media;
  };
  const autoplayRefusal = () => new DOMException("play() failed because the user didn't interact with the document first.", "NotAllowedError");
  HTMLMediaElement.prototype.play = asNative(play, (target, self, args) => {
    if (trackDetachedMedia(self) && blockAutoplay && !askedToPlay()) return Promise.reject(autoplayRefusal());
    return apply(target, self, args);
  });

  const proto = session && Object.getPrototypeOf(session);
  if (proto) {
    const wrapSetter = (name, changed) => {
      const d = Object.getOwnPropertyDescriptor(proto, name);
      if (!d || !d.set) return;
      Object.defineProperty(proto, name, {
        ...d,
        set(value) {
          d.set.call(this, value);
          changed?.();
          reportNowPlaying();
        },
      });
    };
    wrapSetter("metadata");
    wrapSetter("playbackState", () => timeline && restartTimelineClock(clockPosition(timeline.playbackRate, timeline.clock, performance.now())));
    const setActionHandler = proto.setActionHandler;
    proto.setActionHandler = function (action, handler) {
      if (action === "enterpictureinpicture") {
        pipHandlerSet = !!handler;
        if (pipTrace) send("pipTrace", { event: "setActionHandler", action, set: pipHandlerSet });
      }
      const result = setActionHandler.apply(this, arguments);
      if (handler) actions.set(action, handler);
      else actions.delete(action);
      reportNowPlaying();
      return result;
    };
    const setPositionState = proto.setPositionState;
    proto.setPositionState = function (state) {
      const result = setPositionState.apply(this, arguments);
      const media = reachableMedia();
      timeline = typeof state?.duration === "number" ? { position: state.position ?? 0, duration: state.duration, playbackRate: state.playbackRate ?? 1, mediaTimes: mediaTimesOf(media), started: [...media, ...playingMedia].some(isPlaying) } : null;
      positionState = timeline ? state : null;
      if (timeline) {
        restartTimelineClock(timeline.position);
        const reported = timeline;
        queueMicrotask(guard(() => timeline === reported && (reported.mediaTimes = mediaTimesOf(reachableMedia()))));
      }
      reportNowPlaying();
      return result;
    };
  }
  const playableMedia = (all) => all.find((m) => m.currentSrc || m.srcObject || m.src || m.querySelector("source[src]")) || null;
  const pictureInPictureMedia = (root) => {
    let el = root.pictureInPictureElement || null;
    while (el?.shadowRoot?.pictureInPictureElement) el = el.shadowRoot.pictureInPictureElement;
    return el;
  };
  const mediaCommandTarget = (action, inPictureInPicture, pick) => {
    if (action !== "seekPictureInPictureBy") return { action, el: pick() };
    if (!inPictureInPicture) return null;
    return { action: "seekBy", el: typeof inPictureInPicture.currentTime === "number" ? inPictureInPicture : null };
  };
  const reachableMedia = () => [...new Set([...document.querySelectorAll("video,audio"), active, pictureInPictureMedia(document)])].filter((m) => typeof m?.currentTime === "number");
  const clockPosition = (rate, clock, now) => {
    return clock.position + (clock.advancing ? ((now - clock.at) / 1000) * rate : 0);
  };
  const timelineNow = (reported, mediaAdvance, now) => {
    const position = mediaAdvance == null ? clockPosition(reported.playbackRate, reported.clock, now) : reported.position + mediaAdvance;
    return { position: Math.max(0, Math.min(reported.duration, position)), duration: reported.duration };
  };
  const mediaTimesOf = (media) => new WeakMap(media.map((m) => [m, m.currentTime]));
  const incidentalSound = (m, timeline) => oneShot(m) && m.duration * 2 < timeline.duration;
  const anchorStartedMedia = (timeline, m, followed, now) => {
    if (incidentalSound(m, timeline)) return null;
    const started = timeline.started;
    timeline.started = true;
    const followedAdvance = followed === m ? null : mediaAdvanceOf(followed, timeline);
    if (timeline.mediaTimes.has(m) && followedAdvance == null) return null;
    const position = started ? timelineNow(timeline, followedAdvance, now).position : timeline.position;
    timeline.mediaTimes.set(m, m.currentTime - (position - timeline.position));
    return position;
  };
  const mediaAdvanceOf = (el, timeline) => (el && !incidentalSound(el, timeline) && timeline.mediaTimes.has(el) ? el.currentTime - timeline.mediaTimes.get(el) : null);
  const timelineReport = (timeline, el, now) => {
    const mediaAdvance = mediaAdvanceOf(el, timeline);
    return { position: timelineNow(timeline, mediaAdvance, now).position, playbackRate: mediaAdvance == null ? timeline.playbackRate : el.playbackRate };
  };
  const restartTimelineClock = (position) => {
    timeline.clock = { position, at: performance.now(), advancing: session.playbackState !== "paused" };
  };
  const seekByCall = (seconds, el, registered, timeline) => {
    if (registered(seconds >= 0 ? "seekforward" : "seekbackward")) return seconds >= 0 ? ["seekforward", { seekOffset: seconds }] : ["seekbackward", { seekOffset: -seconds }];
    const within = (position, duration) => ({ seekTime: Math.max(0, Math.min(duration || Infinity, position + seconds)) });
    if (registered("seekto")) {
      const at = timeline || (el && { position: el.currentTime, duration: el.duration });
      return at ? ["seekto", within(at.position, at.duration)] : null;
    }
    return el ? ["currentTime", within(el.currentTime, el.duration)] : null;
  };
  handlers.media = ({ action: asked, seconds }) => {
    const target = mediaCommandTarget(asked, pictureInPictureMedia(document), () => pickMedia() || playableMedia([...document.querySelectorAll("video,audio")]));
    if (!target) return;
    const { action, el } = target;
    const call = (name, details) => {
      const h = actions.get(name);
      if (!h) return false;
      h({ action: name, ...details });
      return true;
    };
    const askToSeek = (name, details, landsAt) => {
      const reported = timeline;
      if (!call(name, details)) return false;
      if (timeline && timeline === reported) restartTimelineClock(landsAt(timeline));
      return true;
    };
    const playing = session?.playbackState === "playing" || (el && !el.paused);
    if (action === "play" || action === "toggle") usedHere = true;
    switch (action) {
      case "play":
        call("play") || el?.play();
        break;
      case "pause":
        call("pause") || el?.pause();
        break;
      case "toggle":
        if (playing) call("pause") || el?.pause();
        else call("play") || el?.play();
        break;
      case "next":
        call("nexttrack");
        break;
      case "previous":
        call("previoustrack");
        break;
      case "seekBy": {
        const mediaAdvance = timeline && mediaAdvanceOf(el, timeline);
        const [how, details] = seekByCall(seconds, el, (name) => actions.has(name), timeline && timelineNow(timeline, mediaAdvance, performance.now())) || [];
        if (how === "currentTime") el.currentTime = details.seekTime;
        else if (how === "seekto") askToSeek(how, details, () => details.seekTime);
        else if (how) askToSeek(how, details, (reported) => clockPosition(reported.playbackRate, reported.clock, performance.now()) + seconds);
        break;
      }
      case "seekTo":
        if (!askToSeek("seekto", { seekTime: seconds }, () => seconds) && el) el.currentTime = seconds;
        break;
      case "stop":
        call("stop") || el?.pause();
        break;
      case "enterpictureinpicture":
        call("enterpictureinpicture");
        break;
    }
    lastNowPlaying = null;
    reportNowPlaying();
  };

  const typedByUser = new WeakSet();
  let revealedField = null;
  let eyeField = null;
  let eyeHost = null;
  let eyeButton = null;
  const isPassword = (el) => el.type === "password" || el === revealedField;
  const EYE =
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8Z"/><circle cx="8" cy="8" r="2.1"/></svg>';
  const EYE_SLASH =
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"><path d="M6.2 3.8A6.6 6.6 0 0 1 8 3.5c4.1 0 6.5 4.5 6.5 4.5a11 11 0 0 1-1.7 2.2M4.3 4.9C2.5 6.1 1.5 8 1.5 8s2.4 4.5 6.5 4.5c1.2 0 2.3-.4 3.2-.9"/><path d="M6.6 6.6a2.1 2.1 0 0 0 2.8 2.8"/><path d="M2 2l12 12"/></svg>';
  const hasOwnToggle = (el) => {
    for (let n = el.parentElement, depth = 0; n && depth < 3 && n.querySelectorAll("input").length === 1; n = n.parentElement, depth++)
      for (const c of n.querySelectorAll('button, [role="button"], [aria-label], [title], [class*="eye" i], [class*="toggle" i]'))
        if (c !== el && /show|hide|reveal|toggle|visib|eye|peek|afficher|mostrar|anzeigen/i.test((c.getAttribute("aria-label") || "") + " " + (c.getAttribute("title") || "") + " " + (c.getAttribute("class") || "")))
          return true;
    return false;
  };
  const placeEye = () => {
    if (!eyeHost || !eyeField) return;
    const r = eyeField.getBoundingClientRect();
    const cs = getComputedStyle(eyeField);
    const size = Math.min(24, Math.max(18, r.height - 8));
    const rtl = cs.direction === "rtl";
    const inset = Math.max(4, Math.min(10, parseFloat(rtl ? cs.paddingLeft : cs.paddingRight) || 4));
    const border = parseFloat(rtl ? cs.borderLeftWidth : cs.borderRightWidth) || 0;
    eyeHost.style.left = (rtl ? r.left + border + inset : r.right - border - inset - size) + "px";
    eyeHost.style.top = r.top + (r.height - size) / 2 + "px";
    eyeButton.style.width = eyeButton.style.height = size + "px";
    eyeButton.style.color = cs.color;
  };
  const hideEye = () => {
    if (eyeHost) eyeHost.style.display = "none";
    eyeField = null;
  };
  const conceal = () => {
    const el = revealedField;
    if (!el) return;
    revealedField = null;
    if (el.type === "text") el.type = "password";
    if (eyeButton) eyeButton.innerHTML = EYE;
  };
  const ensureEye = () => {
    if (eyeHost && eyeHost.isConnected) return;
    eyeHost = document.createElement("ardia-reveal");
    eyeHost.style.cssText = "all:initial;position:fixed;z-index:2147483647;display:none;";
    const root = eyeHost.attachShadow({ mode: "closed" });
    root.innerHTML =
      "<style>button{all:initial;box-sizing:border-box;display:flex;align-items:center;justify-content:center;border-radius:5px;cursor:default;opacity:.55;transition:opacity .12s,background-color .12s}" +
      "button:hover{opacity:.85;background:color-mix(in srgb,currentColor 9%,transparent)}button:active{background:color-mix(in srgb,currentColor 16%,transparent)}</style>" +
      '<button type="button" tabindex="-1"></button>';
    eyeButton = root.querySelector("button");
    eyeButton.innerHTML = EYE;
    eyeButton.addEventListener("mousedown", (e) => e.preventDefault());
    eyeButton.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const el = eyeField;
      if (!el) return;
      const [start, end] = [el.selectionStart, el.selectionEnd];
      if (revealedField === el) conceal();
      else {
        revealedField = el;
        el.type = "text";
        eyeButton.innerHTML = EYE_SLASH;
      }
      eyeButton.title = revealedField ? "Hide password" : "Show password";
      el.focus();
      try {
        el.setSelectionRange(start, end);
      } catch {}
    });
    eyeButton.title = "Show password";
    document.documentElement.appendChild(eyeHost);
  };
  const updateEye = guard(() => {
    const el = document.activeElement;
    const show = el instanceof HTMLInputElement && isPassword(el) && el.value && typedByUser.has(el) && el.getBoundingClientRect().width >= 80;
    if (!show) return hideEye();
    if (eyeField !== el && hasOwnToggle(el)) return hideEye();
    ensureEye();
    eyeField = el;
    eyeHost.style.display = "block";
    placeEye();
  });
  document.addEventListener(
    "input",
    guard((e) => {
      const el = e.target;
      if (!(el instanceof HTMLInputElement) || !isPassword(el)) return;
      if (!el.value) typedByUser.delete(el);
      else if (e.isTrusted) typedByUser.add(el);
      updateEye();
    }),
    true,
  );
  document.addEventListener("focusin", updateEye, true);
  document.addEventListener(
    "focusout",
    guard((e) => {
      setTimeout(() => {
        if (document.activeElement === e.target) return;
        if (revealedField === e.target) conceal();
        updateEye();
      }, 0);
    }),
    true,
  );
  document.addEventListener("submit", conceal, true);
  document.addEventListener("keydown", (e) => e.key === "Enter" && conceal(), true);
  document.addEventListener(
    "click",
    (e) => {
      const b = e.target.closest && e.target.closest('button, input[type="submit"], [role="button"]');
      if (b && eyeHost && !eyeHost.contains(b)) conceal();
    },
    true,
  );
  addEventListener("scroll", () => eyeField && requestAnimationFrame(placeEye), { passive: true, capture: true });
  addEventListener("resize", () => eyeField && requestAnimationFrame(placeEye));
  addEventListener("pagehide", conceal);

  let pageNotification = null;
  const installNotifications = () => {
    const NativeNotification = window.Notification;
    if (!NativeNotification || NativeNotification === pageNotification) return !!NativeNotification;
    const pageNotifications = new WeakSet();
    const live = new Map();
    let seq = 0;
    const show = (title, options, fire) => {
      options = options || {};
      const id = frame + ":" + ++seq;
      const icon = options.icon ? absolute(String(options.icon)) : null;
      if (options.tag)
        for (const [otherId, n] of live)
          if (n.tag === String(options.tag)) {
            live.delete(otherId);
            n._fire("close");
          }
      send("notification", {
        id,
        title: String(title),
        body: options.body == null ? "" : String(options.body),
        icon,
        tag: options.tag == null ? "" : String(options.tag),
        silent: !!options.silent,
        requireInteraction: !!options.requireInteraction,
      });
      return id;
    };
    class PageNotification extends EventTarget {
      constructor(title, options) {
        if (arguments.length < 1) throw new TypeError("Failed to construct 'Notification': 1 argument required, but only 0 present.");
        super();
        pageNotifications.add(this);
        options = options || {};
        const fields = { title: String(title), body: String(options.body ?? ""), tag: String(options.tag ?? ""),
          icon: String(options.icon ?? ""), data: options.data ?? null, silent: !!options.silent,
          requireInteraction: !!options.requireInteraction, dir: options.dir || "auto", lang: options.lang || "" };
        for (const [k, v] of Object.entries(fields)) Object.defineProperty(this, k, { value: v, enumerable: true });
        this.onclick = this.onshow = this.onclose = this.onerror = null;
        Object.defineProperty(this, "_fire", {
          value: (type) => {
            const event = new Event(type, { cancelable: type === "click" });
            const handler = this["on" + type];
            if (typeof handler === "function") guard(handler).call(this, event);
            this.dispatchEvent(event);
            return event;
          },
        });
        if (NativeNotification.permission !== "granted") {
          setTimeout(() => this._fire("error"), 0);
          return;
        }
        const id = show(title, options);
        live.set(id, this);
        Object.defineProperty(this, "_id", { value: id });
        setTimeout(() => this._fire("show"), 0);
      }
    }
    const closeNotification = (n) => {
      if (!n._id || !live.has(n._id)) return;
      live.delete(n._id);
      send("notificationClose", { id: n._id });
      setTimeout(() => n._fire("close"), 0);
    };
    const nativeClose = NativeNotification.prototype.close;
    Object.defineProperty(PageNotification.prototype, "close", {
      value: asNative(nativeClose, (target, self, args) => (pageNotifications.has(self) ? closeNotification(self) : apply(target, self, args))),
      writable: true,
      enumerable: true,
      configurable: true,
    });
    for (const key of ["permission", "maxActions", "requestPermission"]) {
      const native = Object.getOwnPropertyDescriptor(NativeNotification, key);
      if (native) Object.defineProperty(PageNotification, key, native);
    }
    Object.defineProperty(PageNotification, "name", { value: "Notification" });
    Object.defineProperty(PageNotification, "length", { value: 1 });
    pageNotification = asNative(PageNotification, () => {
      throw new TypeError("Failed to construct 'Notification': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
    });
    Object.defineProperty(PageNotification.prototype, "constructor", { value: pageNotification, writable: true, configurable: true });
    window.Notification = pageNotification;
    const Registration = window.ServiceWorkerRegistration;
    const nativeShow = Registration && Registration.prototype.showNotification;
    const activeWorker = nativeShow && Object.getOwnPropertyDescriptor(Registration.prototype, "active");
    if (nativeShow && activeWorker && activeWorker.get) {
      Registration.prototype.showNotification = asNative(nativeShow, (target, self, args) => {
        let worker = null;
        try {
          worker = apply(activeWorker.get, self, []);
        } catch (e) {
          return apply(target, self, args);
        }
        if (!worker || args.length < 1 || NativeNotification.permission !== "granted") return apply(target, self, args);
        show(args[0], args[1]);
        return Promise.resolve();
      });
    }
    handlers.notification = ({ id, action }) => {
      const n = live.get(id);
      if (!n) return;
      if (action === "click") {
        const event = n._fire("click");
        if (!event.defaultPrevented) window.focus();
      } else {
        live.delete(id);
        n._fire("close");
      }
    };
    return true;
  };
  if (!installNotifications()) queueMicrotask(() => installNotifications() || setTimeout(installNotifications, 0));

  if (isTop && window.isSecureContext && window.Navigator) {
    const navigatorProto = window.Navigator.prototype;
    const PromiseType = Promise;
    const { reject: promiseReject, resolve: promiseResolve } = Promise;
    const promiseThen = Promise.prototype.then;
    const { trunc } = Math;
    const MAX_BADGE = 9007199254740991;
    const badgeCount = (contents) => {
      if (contents === undefined) return null;
      const n = trunc(+contents);
      if (!isFinite(n)) throw new TypeError("Failed to execute 'setAppBadge' on 'Navigator': Value is not of type 'unsigned long long'.");
      if (n < 0 || n > MAX_BADGE) throw new TypeError("Failed to execute 'setAppBadge' on 'Navigator': Value is outside the 'unsigned long long' value range.");
      return n === 0 ? 0 : n;
    };
    const ignore = () => {};
    const BADGE_GAP_MS = 250;
    const clock = Date.now;
    let shownBadge;
    let nextBadge;
    let sentAt = -Infinity;
    let queued = false;
    const sendBadge = () => {
      queued = false;
      if (nextBadge === shownBadge) return;
      shownBadge = nextBadge;
      sentAt = clock();
      send("appBadge", nextBadge === null ? { flag: true } : { count: nextBadge });
    };
    const noteBadge = (count) => {
      nextBadge = count;
      if (queued) return;
      const wait = sentAt + BADGE_GAP_MS - clock();
      if (wait <= 0) return sendBadge();
      queued = true;
      setTimeout(guard(sendBadge), wait);
    };
    const afterChrome = (result, count) => {
      if (result && typeof result === "object") guard(() => apply(promiseThen, result, [() => noteBadge(count), ignore]))();
      return result;
    };
    const install = (name, native, run) =>
      typeof native === "function"
        ? (navigatorProto[name] = asNative(native, (target, self, args) => (self === navigator ? run(target, self, args) : apply(target, self, args))))
        : Object.defineProperty(navigatorProto, name, {
            value: {
              [name]() {
                if (this !== navigator) return apply(promiseReject, PromiseType, [new TypeError("Illegal invocation")]);
                return run(null, this, arguments);
              },
            }[name],
            writable: true,
            enumerable: true,
            configurable: true,
          });
    install("setAppBadge", navigatorProto.setAppBadge, (target, self, args) => {
      let count;
      try {
        count = badgeCount(args[0]);
      } catch (e) {
        return apply(promiseReject, PromiseType, [e]);
      }
      if (!target) return afterChrome(apply(promiseResolve, PromiseType, []), count);
      return afterChrome(apply(target, self, count === null ? [] : [count]), count);
    });
    install("clearAppBadge", navigatorProto.clearAppBadge, (target, self) =>
      afterChrome(target ? apply(target, self, []) : apply(promiseResolve, PromiseType, []), 0),
    );
  }
  const PO = window.PerformanceObserver;
  const disconnect = PO && PO.prototype.disconnect;
  const { addEventListener: listen, removeEventListener: unlisten } = EventTarget.prototype;
  const raf = window.requestAnimationFrame;
  const holds = (outer, inner) => {
    for (let n = inner; n; n = n.parentNode || n.host) if (n === outer) return true;
    return false;
  };
  const pinnedOver = (el, x, y) => {
    for (let e = document.elementFromPoint(x, y); e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
      if (holds(e, el)) return null;
      const position = getComputedStyle(e).position;
      if (position === "fixed" || position === "sticky") return e.getBoundingClientRect();
    }
    return null;
  };
  const opaqueBackground = (el) => {
    for (let e = el; e; e = e.parentElement) {
      const m = /^rgba?\(([^)]*)\)$/.exec(getComputedStyle(e).backgroundColor);
      const parts = m ? m[1].split(/[\s,/]+/).filter(Boolean).map(Number) : [];
      if (parts.length >= 3 && (parts.length < 4 || parts[3] >= 0.98)) return parts.slice(0, 3);
    }
    return null;
  };
  const cornerRadius = (el, r) => {
    for (let e = el, depth = 0; e && e !== document.body && depth < 8; e = e.parentElement, depth++) {
      const style = getComputedStyle(e);
      const radius = parseFloat(style.borderTopLeftRadius) || 0;
      if (radius <= 0 || (e !== el && style.overflow === "visible")) continue;
      const box = e.getBoundingClientRect();
      const near = (a, b) => Math.abs(a - b) < 2;
      if (!(near(box.left, r.left) && near(box.right, r.right) && near(box.top, r.top) && near(box.bottom, r.bottom))) break;
      return { radius, backdrop: opaqueBackground(e.parentElement) };
    }
    return { radius: 0, backdrop: null };
  };
  const pinnedCover = (el, r) => {
    const left = Math.max(r.left, 0);
    const right = Math.min(r.right, innerWidth);
    const top = Math.max(r.top, 0);
    const bottom = Math.min(r.bottom, innerHeight);
    const cover = { top: 0, bottom: 0, radius: 0, backdrop: null };
    if (right - left < 2 || bottom - top < 2) return cover;
    const corner = cornerRadius(el, r);
    cover.radius = corner.radius;
    cover.backdrop = corner.backdrop;
    for (let i = 1; i <= 3; i++) {
      const x = left + ((right - left) * i) / 4;
      const above = pinnedOver(el, x, top + 1);
      if (above && above.top <= top + 1) cover.top = Math.max(cover.top, Math.min(above.bottom, bottom) - r.top);
      const below = pinnedOver(el, x, bottom - 1);
      if (below && below.bottom >= bottom - 1) cover.bottom = Math.max(cover.bottom, r.bottom - Math.max(below.top, top));
    }
    return cover;
  };
  const dateNow = Date.now;
  const timeOrigin = performance.timeOrigin;
  let fieldTiming = null;
  const setFieldTiming = (on) => {
    if (!isTop || !on === !fieldTiming) return;
    if (!on) {
      fieldTiming.live = false;
      try {
        if (fieldTiming.observer) apply(disconnect, fieldTiming.observer, []);
      } catch (e) {}
      apply(unlisten, document, ["visibilitychange", fieldTiming.onVisibility]);
      fieldTiming = null;
      return;
    }
    const state = (fieldTiming = { live: true, observer: null, onVisibility: null });
    const report = (data) => state.live && send("perf", data);
    try {
      state.observer = new PO((list) => {
        for (const e of list.getEntries()) if (e.name === "first-contentful-paint") report({ fcp: timeOrigin + e.startTime });
      });
      state.observer.observe({ type: "paint", buffered: true });
    } catch (e) {}
    state.onVisibility = () => {
      if (!state.live || document.visibilityState !== "visible") return;
      apply(raf, window, [() => apply(raf, window, [() => report({ shown: apply(dateNow, Date, []) })])]);
    };
    apply(listen, document, ["visibilitychange", state.onVisibility]);
  };
  handlers.fieldTiming = (message) => setFieldTiming(!!(message && message.on));
  let firstPaintObserver = null;
  handlers.firstPaint = () => {
    if (!isTop || firstPaintObserver) return;
    const painted = () => send("firstPaint", { url: location.href });
    try {
      firstPaintObserver = new PO((list) => {
        for (const e of list.getEntries())
          if (e.name === "first-contentful-paint") {
            apply(disconnect, firstPaintObserver, []);
            return painted();
          }
      });
      firstPaintObserver.observe({ type: "paint", buffered: true });
    } catch (e) {
      firstPaintObserver = true;
      onReady(() => apply(raf, window, [painted]));
    }
  };
  handlers.wakeFrames = () => apply(raf, window, [() => {}]);

  const pauseUnasked = (media, activated) => {
    if (activated) return 0;
    let paused = 0;
    for (const m of media)
      if (m && !m.paused) {
        m.pause();
        paused++;
      }
    return paused;
  };

  let peekKey = null;
  let splitKey = null;
  let peekTrace = false;
  let peekOtherSites = false;
  handlers.peekConfig = (config) => {
    peekKey = config && (config.modifier === "alt" || config.modifier === "shift") ? config.modifier : null;
    splitKey = config && (config.split === "alt" || config.split === "altShift") ? config.split : null;
    peekTrace = !!(config && config.trace);
    peekOtherSites = !!(config && config.otherSites === true);
  };
  try {
    const getter = (proto, name) => {
      const get = Object.getOwnPropertyDescriptor(proto, name).get;
      return (o) => apply(get, o, []);
    };
    const [clientX, clientY, button, altKey, shiftKey, metaKey, ctrlKey] = ["clientX", "clientY", "button", "altKey", "shiftKey", "metaKey", "ctrlKey"].map((n) =>
      getter(MouseEvent.prototype, n),
    );
    const nodeType = getter(Node.prototype, "nodeType");
    const localName = getter(Element.prototype, "localName");
    const anchorHref = getter(HTMLAnchorElement.prototype, "href");
    const areaHref = getter(HTMLAreaElement.prototype, "href");
    const baseURI = getter(Node.prototype, "baseURI");
    const ratio = getter(window, "devicePixelRatio");
    const composedPath = Event.prototype.composedPath;
    const preventDefault = Event.prototype.preventDefault;
    const stopImmediatePropagation = Event.prototype.stopImmediatePropagation;
    const hasAttribute = Element.prototype.hasAttribute;
    const getAttribute = Element.prototype.getAttribute;
    const getAttributeNS = Element.prototype.getAttributeNS;
    const test = RegExp.prototype.test;
    const includes = Array.prototype.includes;
    const sliceText = String.prototype.slice;
    const { hypot } = Math;
    const URLCtor = URL;
    const SVG = "http://www.w3.org/2000/svg";
    const PRESS_SLOP = 5;
    const MAX_SITE_PEEK_URL = 8192;
    const namespace = getter(Element.prototype, "namespaceURI");
    const timeStamp = getter(Event.prototype, "timeStamp");
    const persisted = getter(PageTransitionEvent.prototype, "persisted");
    const pageOrigin = location.origin;
    const pageHost = location.hostname;
    const pageIsWeb = apply(test, /^https?:$/, [location.protocol]);
    const hostnameOf = getter(URL.prototype, "hostname");
    const querySelector = Document.prototype.querySelector;
    const selectionOf = Document.prototype.getSelection;
    const collapsed = getter(Selection.prototype, "isCollapsed");
    const now = () => apply(dateNow, Date, []);
    const linkUrl = (el) => {
      const name = localName(el);
      if (name !== "a" && name !== "area") return null;
      if (namespace(el) === SVG) {
        const raw = apply(getAttribute, el, ["href"]) ?? apply(getAttributeNS, el, ["http://www.w3.org/1999/xlink", "href"]);
        return raw === null ? "" : new URLCtor(raw, baseURI(el)).href;
      }
      if (!apply(hasAttribute, el, ["href"])) return "";
      return name === "a" ? anchorHref(el) : areaHref(el);
    };
    const linkAt = (e) => {
      const path = apply(composedPath, e, []);
      for (let i = 0; i < path.length; i++) {
        const node = path[i];
        if (node === window || node === document || nodeType(node) !== 1) continue;
        const url = linkUrl(node);
        if (url !== null) return { link: node, url, path };
      }
      return null;
    };
    const XHTML = "http://www.w3.org/1999/xhtml";
    const isContentEditable = getter(HTMLElement.prototype, "isContentEditable");
    const createElement = Document.prototype.createElement;
    const setAttribute = Element.prototype.setAttribute;
    const clickElement = HTMLElement.prototype.click;
    const inEditable = (path) => {
      for (let i = 0; i < path.length; i++) {
        const node = path[i];
        if (node === window || node === document || nodeType(node) !== 1) continue;
        if (namespace(node) === XHTML) return isContentEditable(node);
      }
      return false;
    };
    const peekable = (hit) =>
      !!hit && !!hit.url && !apply(hasAttribute, hit.link, ["download"]) && apply(test, /^https?:/i, [hit.url]) && !inEditable(hit.path);
    const keys = (e) => ({ alt: altKey(e), shift: shiftKey(e), meta: metaKey(e), ctrl: ctrlKey(e) });
    const keyOf = (e) => {
      if (ctrlKey(e)) return null;
      if (metaKey(e)) return altKey(e) && !shiftKey(e) ? "altMeta" : null;
      if (altKey(e)) return shiftKey(e) ? "altShift" : "alt";
      return shiftKey(e) ? "shift" : null;
    };
    const chosen = (e) => {
      const key = keyOf(e);
      if (!key) return null;
      if (key === peekKey) return key;
      if (!splitKey) return null;
      if (key === "altShift" || key === "altMeta") return key;
      return key === "alt" && splitKey === "alt" ? key : null;
    };
    const anyKey = () => !!(peekKey || splitKey || peekOtherSites);
    const trace = (what, data) => peekTrace && send("peekTrace", { what, key: peekKey, split: splitKey, otherSites: peekOtherSites, ...data });
    const plainPress = (e) => !altKey(e) && !shiftKey(e) && !metaKey(e) && !ctrlKey(e);
    const siteKey = (e) => (peekOtherSites && isTop && pageIsWeb && plainPress(e) ? "site" : null);
    const withoutWww = (host) => (apply(test, /^www\./i, [host]) ? apply(sliceText, host, [4]) : host);
    const targetOf = (link) => {
      const own = apply(getAttribute, link, ["target"]);
      if (own !== null) return own;
      const base = apply(querySelector, document, ["base[target]"]);
      return base ? apply(getAttribute, base, ["target"]) || "" : "";
    };
    const replacesPage = (link) => apply(test, /^(_self|_top|_parent)?$/i, [targetOf(link)]);
    const otherSite = (url) => withoutWww(hostnameOf(new URLCtor(url))) !== withoutWww(pageHost);
    const selecting = () => {
      const selection = apply(selectionOf, document, []);
      return !!selection && !collapsed(selection);
    };
    let press = null;
    let peeked = null;
    let siteClick = null;
    let sent = null;
    handlers.peekRefused = (refusal) => {
      const gesture = sent;
      if (!gesture || !refusal || !(refusal.download || refusal.follow) || refusal.url !== gesture.url || now() - gesture.at > 60000) return;
      sent = null;
      if (refusal.follow) {
        trace("native refused, following the link as the click would have", { url: gesture.url, reason: refusal.reason });
        if (namespace(gesture.link) === XHTML) return apply(clickElement, gesture.link, []);
        const follow = apply(createElement, document, ["a"]);
        apply(setAttribute, follow, ["href", gesture.url]);
        apply(setAttribute, follow, ["target", "_self"]);
        return apply(clickElement, follow, []);
      }
      trace("native refused, downloading as the click would have", { url: gesture.url, reason: refusal.reason });
      const a = apply(createElement, document, ["a"]);
      apply(setAttribute, a, ["href", gesture.url]);
      apply(setAttribute, a, ["download", ""]);
      apply(clickElement, a, []);
    };
    addEventListener(
      "mousedown",
      guard((e) => {
        press = null;
        peeked = null;
        siteClick = null;
        if (!e.isTrusted || button(e) !== 0) return;
        const hit = linkAt(e);
        if (!peekable(hit)) return;
        press = { link: hit.link, url: hit.url, x: clientX(e), y: clientY(e) };
        if (!anyKey()) trace("no key chosen yet", { url: hit.url, ...keys(e) });
      }),
      true,
    );
    addEventListener(
      "mouseup",
      guard((e) => {
        const pressed = press;
        press = null;
        if (!pressed || !anyKey() || !e.isTrusted || button(e) !== 0) return;
        const key = chosen(e) || siteKey(e);
        if (!key) return trace("other keys", { url: pressed.url, ...keys(e) });
        const hit = linkAt(e);
        const moved = hypot(clientX(e) - pressed.x, clientY(e) - pressed.y);
        if (!hit || hit.link !== pressed.link) return trace("released off the link", { url: pressed.url, moved });
        if (!peekable(hit)) return trace("the link changed during the press", { url: hit.url, moved });
        if (moved > PRESS_SLOP) return trace("moved too far", { url: hit.url, moved });
        if (key === "site") {
          if (selecting()) return trace("the click belongs to a selection", { url: hit.url });
          siteClick = { link: hit.link, stamp: timeStamp(e) };
          return;
        }
        peeked = { link: hit.link, stamp: timeStamp(e) };
        sent = { url: hit.url, at: now(), link: hit.link };
        const scale = ratio(window);
        send("peek", { url: hit.url, key, origin: pageOrigin, x: clientX(e) * scale, y: clientY(e) * scale, moved });
      }),
      true,
    );
    addEventListener(
      "click",
      guard((e) => {
        const shown = peeked;
        if (!shown || !e.isTrusted || timeStamp(e) !== shown.stamp || !apply(includes, apply(composedPath, e, []), [shown.link])) return;
        peeked = null;
        apply(preventDefault, e, []);
        apply(stopImmediatePropagation, e, []);
      }),
      true,
    );
    const defaultPrevented = getter(Event.prototype, "defaultPrevented");
    const scheduleTimeout = window.setTimeout;
    const carriesUrl = (url) => apply(test, /[?&][^=&#]*=(https?(:|%3A)(\/\/|%2F%2F))/i, [url]);
    const peekSiteLink = (e, link) => {
      if (defaultPrevented(e)) return trace("the page handled the click", {});
      const url = linkUrl(link);
      if (!peekable({ link, url, path: [] })) return trace("the link changed during the click", { url });
      if (url.length > MAX_SITE_PEEK_URL) return trace("the link is too long to hand over", { length: url.length });
      if (!otherSite(url) && !carriesUrl(url)) return trace("the link stays on this site", { url });
      apply(preventDefault, e, []);
      sent = { url, at: now(), link };
      const scale = ratio(window);
      send("peek", { url, key: "site", origin: pageOrigin, x: clientX(e) * scale, y: clientY(e) * scale, moved: 0 });
    };
    const noteNewTabLink = (e, link) => {
      if (defaultPrevented(e) || replacesPage(link)) return;
      const url = linkUrl(link);
      if (url && apply(test, /^https?:/i, [url])) send("newTabLink", { url });
    };
    addEventListener(
      "click",
      guard((e) => {
        const site = siteClick;
        siteClick = null;
        if (!e.isTrusted || button(e) !== 0 || altKey(e) || shiftKey(e) || metaKey(e) || ctrlKey(e)) return;
        const hit = linkAt(e);
        if (!peekable(hit)) return;
        const path = apply(composedPath, e, []);
        const forSite = !!site && timeStamp(e) === site.stamp && apply(includes, path, [site.link]);
        const link = forSite ? site.link : hit.link;
        let decided = false;
        const decide = guard((ev) => {
          if (ev !== e || decided) return;
          decided = true;
          if (forSite && replacesPage(link)) return peekSiteLink(e, link);
          noteNewTabLink(e, link);
        });
        apply(listen, window, ["click", decide]);
        apply(scheduleTimeout, window, [
          guard(() => {
            apply(unlisten, window, ["click", decide]);
            if (decided) return;
            decided = true;
            if (forSite && replacesPage(link)) return trace("the click never reached the window", {});
            noteNewTabLink(e, link);
          }),
          0,
        ]);
      }),
      true,
    );
    const userActivationOf = window.Navigator && Object.getOwnPropertyDescriptor(Navigator.prototype, "userActivation");
    const activeOf = window.UserActivation && Object.getOwnPropertyDescriptor(UserActivation.prototype, "isActive");
    const openDescriptor = Object.getOwnPropertyDescriptor(window, "open");
    if (userActivationOf && activeOf && openDescriptor && typeof openDescriptor.value === "function") {
      const activated = () => {
        const activation = apply(userActivationOf.get, navigator, []);
        return !!activation && !!apply(activeOf.get, activation, []);
      };
      const openedByUser = (args) => {
        if (!args.length || args[0] === undefined || args[0] === null || !activated()) return;
        const raw = `${args[0]}`;
        if (!raw) return;
        const url = new URLCtor(raw, baseURI(document)).href;
        if (apply(test, /^https?:/i, [url])) send("newTabLink", { url });
      };
      const open = asNative(openDescriptor.value, (target, self, args) => {
        guard(openedByUser)(args);
        return apply(target, self, args);
      });
      Object.defineProperty(window, "open", { ...openDescriptor, value: open });
    }
    addEventListener("pageshow", guard((e) => e.isTrusted && persisted(e) && send("peekHello", {})));
    addEventListener("pagehide", guard((e) => e.isTrusted && send("peekGone", {})));
  } catch (e) {}

  const videoMirror = (() => {
    const MIRROR_ORIGINS = ["https://www.netflix.com", "https://www.disneyplus.com", "https://www.youtube.com"];
    const PLAYER_ROOTS = {
      "https://www.netflix.com": [".watch-video", "[data-uia='watch-video']"],
      "https://www.disneyplus.com": [".btm-media-player", "#hudson-wrapper", "disney-web-player"],
      "https://www.youtube.com": ["#movie_player", ".html5-video-player"],
    };
    const PLAYER_OVERLAYS = {
      "https://www.netflix.com": [".player-info"],
    };
    const CAPTION_REGIONS = {
      "https://www.disneyplus.com": { region: ".timed-text-override-region", box: ".hive-subtitle-renderer-cue-positioning-box", relayoutEvent: "webkitfullscreenchange" },
    };
    const CAPTION_SEARCH_MS = 1000;
    const PART_CHARS = 16000;
    const PART_BYTES = 63000;
    const SLOW_MS = 500;
    const RETRY_MS = 2000;
    const RETRY_LIMIT = 5;
    const ROOT_GROWTH = 1.5;
    const COVER = 0.9;
    const CANVAS_PIXELS = 160000;
    const CANVAS_CHARS = 48000;
    const BLOB_PICTURES = 64;
    const VALUE_CHARS = 2000;
    const ATTR_CHARS = 100000;
    const BATCH_CHARS = 8000000;
    const SVG_NS = "http://www.w3.org/2000/svg";
    const MATH_NS = "http://www.w3.org/1998/Math/MathML";
    const DROPPED = new Set(["script", "noscript", "template", "base", "meta", "title", "link", "style", "track", "param"]);
    const BLANKED = new Set(["iframe", "frame", "frameset", "object", "embed", "portal", "fencedframe", "applet"]);
    const MEDIA = new Set(["video", "audio"]);
    const URL_ATTRS = new Set(["href", "src", "xlink:href", "action", "formaction", "data", "poster", "background", "ping", "srcset", "lowsrc"]);
    const PSEUDO = /(?<!\\):(focus-visible|focus-within|popover-open|-webkit-full-screen|fullscreen|hover|focus|active|modal|defined)(?![\w-])/g;
    const PSEUDO_STATE = { "-webkit-full-screen": "fullscreen" };
    const STATES = ["hover", "active", "focus", "focus-within", "focus-visible", "fullscreen", "popover-open", "modal", "clear"];
    const idle = { start() {}, ensure() {}, stop() {}, prepare() {} };
    if (!isTop) return idle;
    const MO = window.MutationObserver;
    const RO = window.ResizeObserver;
    const repeat = window.setInterval;
    const unrepeat = window.clearInterval;
    const frameLater = window.requestAnimationFrame;
    const clock = performance;
    const clockNow = clock.now;
    const now = () => apply(clockNow, clock, []);
    const encoder = new TextEncoder();
    const closedRoots = new WeakMap();
    const awaitingDefinition = new WeakSet();
    let s = null;
    let testMode = false;
    let retryVideo = null;
    let retryAt = 0;
    let retries = 0;

    const composedParent = (n) => {
      const p = n.parentNode;
      return p && p.nodeType === 11 ? p.host : p;
    };
    const shadowOf = (el) => (el.nodeType === 1 && (el.shadowRoot || closedRoots.get(el))) || null;
    const composedContains = (outer, n) => {
      for (let x = n; x; x = composedParent(x)) if (x === outer) return true;
      return false;
    };
    if (MIRROR_ORIGINS.includes(location.origin) && typeof Element.prototype.attachShadow === "function")
      Element.prototype.attachShadow = asNative(Element.prototype.attachShadow, (target, self, args) => {
        const root = apply(target, self, args);
        if (args[0] && args[0].mode === "closed") closedRoots.set(self, root);
        if (s && s.known.has(self)) {
          s.newShadows.add(self);
          schedule();
        }
        return root;
      });

    const rewriteSelector = (text) =>
      text.replace(PSEUDO, (m, name) => (name === "defined" ? ":not([data-ardia-undefined])" : `[data-ardia-${PSEUDO_STATE[name] || name}]`));
    const absolutize = (text, base) =>
      text.replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/g, (m, q, u) => {
        const url = u.trim();
        if (!url || /^(data:|blob:|about:|#)/i.test(url)) return m;
        try {
          return `url("${new URL(url, base).href}")`;
        } catch (e) {
          return m;
        }
      });
    const listText = (rules) => {
      let out = "";
      for (let i = 0; i < rules.length; i++) out += ruleText(rules[i]) + "\n";
      return out;
    };
    const ruleText = (rule) => {
      const inner = rule.cssRules;
      if (rule instanceof CSSStyleRule) return rewriteSelector(rule.selectorText) + "{" + rule.style.cssText + (inner && inner.length ? listText(inner) : "") + "}";
      if (inner && !(rule instanceof CSSKeyframesRule)) {
        const text = rule.cssText;
        const brace = text.indexOf("{");
        if (brace > 0) return text.slice(0, brace) + "{" + listText(inner) + "}";
      }
      return rule.cssText;
    };
    const fetched = new Map();
    const fetchSheet = (href) => {
      if (fetched.has(href) || !/^https:/.test(href)) return;
      fetched.set(href, null);
      fetch(href, { credentials: "omit", mode: "cors" })
        .then((r) => (r.ok ? r.text() : null))
        .then((text) => {
          if (text === null) return;
          const sheet = new CSSStyleSheet();
          sheet.replaceSync(text);
          fetched.set(href, absolutize(listText(sheet.cssRules), href));
          schedule();
        })
        .catch(() => {});
    };
    const sheetIds = new WeakMap();
    let sheetSeq = 0;
    const sheetEdits = new WeakMap();
    const noteSheetEdit = (sheet) => {
      if (!sheet) return;
      sheetEdits.set(sheet, (sheetEdits.get(sheet) || 0) + 1);
      if (s) schedule();
    };
    const watchSheetEdits = (proto, names, sheetOf) => {
      if (!proto) return;
      const edited = (target, self, args) => {
        const result = apply(target, self, args);
        const sheet = sheetOf(self);
        noteSheetEdit(sheet);
        if (result && typeof result.then === "function") result.then(() => noteSheetEdit(sheet), () => noteSheetEdit(sheet));
        return result;
      };
      for (const name of names) {
        const was = Object.getOwnPropertyDescriptor(proto, name);
        if (was && typeof was.value === "function") Object.defineProperty(proto, name, { ...was, value: asNative(was.value, edited) });
        else if (was && was.set) Object.defineProperty(proto, name, { ...was, set: asNative(was.set, edited) });
      }
    };
    if (MIRROR_ORIGINS.includes(location.origin)) {
      const ruleSheet = (rule) => rule && rule.parentStyleSheet;
      watchSheetEdits(window.CSSStyleSheet && CSSStyleSheet.prototype, ["insertRule", "deleteRule", "addRule", "removeRule", "replace", "replaceSync"], (sheet) => sheet);
      watchSheetEdits(window.CSSGroupingRule && CSSGroupingRule.prototype, ["insertRule", "deleteRule"], ruleSheet);
      watchSheetEdits(window.CSSKeyframesRule && CSSKeyframesRule.prototype, ["appendRule", "deleteRule"], ruleSheet);
      watchSheetEdits(window.CSSStyleRule && CSSStyleRule.prototype, ["selectorText"], ruleSheet);
      watchSheetEdits(window.CSSStyleDeclaration && CSSStyleDeclaration.prototype, ["setProperty", "removeProperty", "cssText"], (style) => ruleSheet(style.parentRule));
    }
    const sheetEntry = (sheet) => {
      let rules = null;
      try {
        rules = sheet.cssRules;
      } catch (e) {}
      const media = sheet.media && sheet.media.mediaText;
      const wrap = (text) => (media ? `@media ${media}{${text}}` : text);
      if (rules) return { sig: `r${rules.length}|${sheetEdits.get(sheet) || 0}|${media || ""}`, x: () => wrap(absolutize(listText(rules), sheet.href || document.baseURI)) };
      if (!sheet.href) return null;
      const text = fetched.get(sheet.href);
      if (text) return { sig: "f|" + (media || ""), x: () => wrap(text) };
      fetchSheet(sheet.href);
      return { sig: "h|" + (media || ""), h: sheet.href, m: media || "" };
    };
    const sheetList = (scope, pre) => {
      const ids = [];
      const all = [...scope.styleSheets, ...(scope.adoptedStyleSheets || [])];
      for (const sheet of all) {
        if (sheet.disabled) continue;
        let id = sheetIds.get(sheet);
        if (!id) sheetIds.set(sheet, (id = ++sheetSeq));
        const entry = sheetEntry(sheet);
        if (!entry) continue;
        ids.push(id);
        if (s.sheetSigs.get(id) === entry.sig) continue;
        s.sheetSigs.set(id, entry.sig);
        pre.push(entry.h ? { o: "put", id, h: entry.h, m: entry.m } : { o: "put", id, x: entry.x() });
      }
      return ids;
    };
    const syncSheets = (pre) => {
      const scopes = [[0, document]];
      for (const root of s.shadows) if (s.known.has(root.host)) scopes.push([s.ids.get(root.host), root]);
      for (const [key, scope] of scopes) {
        const ids = sheetList(scope, pre);
        const joined = ids.join(",");
        if (s.sheetLists.get(key) === joined) continue;
        s.sheetLists.set(key, joined);
        pre.push({ o: "sl", i: key, l: ids });
      }
    };

    const idOf = (n) => {
      let id = s.ids.get(n);
      if (!id) s.ids.set(n, (id = ++s.idSeq));
      return id;
    };
    const cleanAttr = (tag, name, value) => {
      const lower = name.toLowerCase();
      if (lower.startsWith("on") || lower === "nonce" || lower === "srcdoc" || lower === "autofocus" || lower.startsWith("data-ardia-")) return null;
      if (MEDIA.has(tag) && (lower === "src" || lower === "poster" || lower === "autoplay" || lower === "controls")) return null;
      if (BLANKED.has(tag) && (lower === "src" || lower === "data")) return null;
      if (URL_ATTRS.has(lower) && /^(javascript|vbscript|blob):/.test(value.replace(/[\u0000-\u0020]/g, "").toLowerCase())) return null;
      return value.length > ATTR_CHARS ? null : value;
    };
    const attrsOf = (el) => {
      const tag = el.localName;
      const out = [];
      const list = el.attributes;
      for (let i = 0; i < list.length; i++) {
        const value = cleanAttr(tag, list[i].name, list[i].value);
        if (value !== null) out.push([list[i].name, value]);
      }
      if (tag.includes("-") && !customElements.get(tag)) {
        out.push(["data-ardia-undefined", ""]);
        if (awaitingDefinition.has(el)) return out;
        awaitingDefinition.add(el);
        customElements.whenDefined(tag).then(() => {
          if (s && s.known.has(el)) {
            s.dirtyAttrs.add(el);
            schedule();
          }
        });
      }
      if (tag === "video" && !el.hasAttribute("width") && el.videoWidth) out.push(["width", String(el.videoWidth)], ["height", String(el.videoHeight)]);
      if (tag === "img" && /^blob:/i.test((el.getAttribute("src") || "").trim())) {
        const picture = blobPicture(el);
        if (picture) out.push(["src", picture]);
      }
      return out;
    };
    const formState = (el, out) => {
      if (el.type === "password") return out;
      if (el.type === "checkbox" || el.type === "radio") out.k = !!el.checked;
      else if (typeof el.value === "string") out.v = el.value.slice(0, VALUE_CHARS);
      return out;
    };
    const canvasPicture = (c) => {
      const pixels = c.width * c.height;
      if (!pixels || pixels > CANVAS_PIXELS) return null;
      try {
        const url = c.toDataURL();
        return url.length <= CANVAS_CHARS ? url : null;
      } catch (e) {
        return null;
      }
    };
    const blobPictures = new Map();
    const loadWatched = new WeakSet();
    const repaintOnLoad = (img) => {
      if (loadWatched.has(img)) return;
      loadWatched.add(img);
      img.addEventListener("load", () => {
        if (!s || !s.known.has(img)) return;
        s.dirtyAttrs.add(img);
        schedule();
      });
    };
    const dataUrlOf = (blob) =>
      new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.readAsDataURL(blob);
      });
    const blobPicture = (img) => {
      const src = img.currentSrc || img.src;
      if (blobPictures.has(src)) return blobPictures.get(src);
      repaintOnLoad(img);
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      if (!img.complete || !w || !h) return null;
      blobPictures.set(src, null);
      if (blobPictures.size > BLOB_PICTURES) blobPictures.delete(blobPictures.keys().next().value);
      const scale = Math.min(1, Math.sqrt(CANVAS_PIXELS / (w * h)));
      const c = new OffscreenCanvas(Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)));
      try {
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      } catch (e) {
        return null;
      }
      c.convertToBlob({ type: "image/jpeg", quality: 0.85 })
        .then(dataUrlOf)
        .then((url) => {
          if (typeof url !== "string" || url.length > CANVAS_CHARS || !blobPictures.has(src)) return;
          blobPictures.set(src, url);
          if (!s || !s.known.has(img)) return;
          s.dirtyAttrs.add(img);
          schedule();
        })
        .catch(() => {});
      return null;
    };
    const remember = (n, fresh) => {
      s.known.add(n);
      fresh.add(n);
      return idOf(n);
    };
    const describe = (n, fresh) => {
      if (n.nodeType === 3) return { i: remember(n, fresh), x: n.data };
      if (n.nodeType !== 1) return null;
      const tag = n.localName;
      if (DROPPED.has(tag)) return null;
      const out = { i: remember(n, fresh), t: BLANKED.has(tag) ? "div" : tag, a: attrsOf(n) };
      if (n.namespaceURI === SVG_NS) out.n = "s";
      else if (n.namespaceURI === MATH_NS) out.n = "m";
      if (n.scrollTop || n.scrollLeft) {
        out.sx = n.scrollLeft;
        out.sy = n.scrollTop;
      }
      if (MEDIA.has(tag) || BLANKED.has(tag)) return out;
      if (tag === "canvas") out.cv = canvasPicture(n);
      if (tag === "input" || tag === "textarea" || tag === "select") formState(n, out);
      out.c = childrenOf(n, fresh);
      const root = shadowOf(n);
      if (root) out.sh = describeShadow(root, fresh);
      return out;
    };
    const describeShadow = (root, fresh) => {
      watchShadow(root);
      return { c: childrenOf(root, fresh) };
    };
    const childrenOf = (parent, fresh) => {
      const out = [];
      for (let n = parent.firstChild; n; n = n.nextSibling) {
        if (s.known.has(n) && !fresh.has(n)) out.push({ r: s.ids.get(n) });
        else {
          const d = describe(n, fresh);
          if (d) out.push(d);
        }
      }
      if (parent === s.root)
        for (const o of s.overlays) {
          const d = s.known.has(o) && !fresh.has(o) ? { r: s.ids.get(o) } : describe(o, fresh);
          if (d) out.push(d);
        }
      return out;
    };
    const forget = (n) => {
      if (!s.known.has(n)) return;
      s.known.delete(n);
      for (let c = n.firstChild; c; c = c.nextSibling) forget(c);
      const root = shadowOf(n);
      if (root) {
        if (s.shadows.delete(root)) listenShadow(root, false);
        for (let c = root.firstChild; c; c = c.nextSibling) forget(c);
      }
    };
    const options = { childList: true, subtree: true, attributes: true, characterData: true };
    const SHADOW_EVENTS = ["scroll", "change"];
    const listenShadow = (root, on) => {
      for (const type of SHADOW_EVENTS) (on ? root.addEventListener : root.removeEventListener).call(root, type, listeners[type], { capture: true, passive: true });
    };
    const unwatchShadows = (st) => {
      for (const root of st.shadows) listenShadow(root, false);
      st.shadows.clear();
    };
    const watchShadow = (root) => {
      if (s.shadows.has(root)) return;
      s.shadows.add(root);
      s.observer.observe(root, options);
      listenShadow(root, true);
    };

    const captionRelayout = (() => {
      const spec = CAPTION_REGIONS[location.origin];
      if (!spec || !RO) return { start() {}, stop() {} };
      let region = null;
      let height = 0;
      let timer = 0;
      const findRegion = (scope) => {
        const hit = scope.querySelector(spec.region);
        if (hit) return hit;
        for (const el of scope.querySelectorAll("*")) {
          const root = shadowOf(el);
          const found = root && findRegion(root);
          if (found) return found;
        }
        return null;
      };
      const relayout = () => {
        if (!region) return;
        const was = height;
        height = region.getBoundingClientRect().height;
        const delta = height - was;
        if (!was || !delta) return;
        for (const box of region.querySelectorAll(spec.box)) {
          const top = parseFloat(box.style.top);
          if (isFinite(top) && top + box.offsetHeight / 2 > was / 2) box.style.top = top + delta + "px";
        }
        document.dispatchEvent(new Event(spec.relayoutEvent));
      };
      const observer = new RO(guard(relayout));
      const track = () => {
        if (region && region.isConnected) return;
        observer.disconnect();
        region = findRegion(document);
        height = 0;
        if (region) observer.observe(region);
      };
      return {
        start() {
          if (timer) return;
          track();
          timer = apply(repeat, window, [guard(track), CAPTION_SEARCH_MS]);
        },
        stop() {
          if (!timer) return;
          apply(unrepeat, window, [timer]);
          timer = 0;
          observer.disconnect();
          region = null;
        },
      };
    })();

    const pickRoot = (video) => {
      for (const selector of PLAYER_ROOTS[location.origin] || []) {
        let found = null;
        try {
          found = document.querySelector(selector);
        } catch (e) {}
        if (found && composedContains(found, video)) return found;
      }
      const base = video.getBoundingClientRect();
      const limit = Math.max(base.width * base.height, 1) * ROOT_GROWTH;
      let best = composedParent(video);
      for (let n = best && composedParent(best); n && n !== document.body && n !== document.documentElement; n = composedParent(n)) {
        const r = n.getBoundingClientRect();
        if (r.width * r.height > limit) break;
        best = n;
      }
      while (best && best.getRootNode() !== document) best = best.getRootNode().host || null;
      return best && best !== document.body && best !== document.documentElement ? best : null;
    };
    const overlaysOf = (root) => {
      const out = [];
      for (const selector of PLAYER_OVERLAYS[location.origin] || []) {
        let found = null;
        try {
          found = document.querySelector(selector);
        } catch (e) {}
        if (found && !composedContains(root, found) && !composedContains(found, root)) out.push(found);
      }
      return out;
    };
    const syncOverlays = () => {
      const found = overlaysOf(s.root);
      if (found.length === s.overlays.length && found.every((o, i) => o === s.overlays[i])) return;
      for (const o of s.overlays) if (!found.includes(o)) forget(o);
      for (const o of found) if (!s.overlays.includes(o)) s.observer.observe(o, options);
      s.overlays = found;
      s.dirtyChildren.add(s.root);
    };
    const pollOverlayValues = () => {
      for (const o of s.overlays)
        for (const el of o.querySelectorAll("textarea,input,select")) {
          if (!s.known.has(el) || s.sentValues.get(el) === el.value) continue;
          s.sentValues.set(el, el.value);
          s.dirtyValues.add(el);
        }
    };
    const shellsOf = (root) => {
      const list = [];
      for (let n = root.parentElement; n; n = n.parentElement) list.unshift(n);
      return list;
    };

    const deepActive = () => {
      let el = document.activeElement;
      for (let depth = 0; el && depth < 32; depth++) {
        const root = shadowOf(el);
        const inner = root && root.activeElement;
        if (!inner) break;
        el = inner;
      }
      return el;
    };
    const pointed = () => {
      if (!s.pointer) return null;
      const { x, y } = s.pointer;
      let el = document.elementFromPoint(x, y);
      for (let depth = 0; el && depth < 32; depth++) {
        const root = shadowOf(el);
        const inner = root && root.elementFromPoint(x, y);
        if (!inner || inner === el) break;
        el = inner;
      }
      return el;
    };
    const chainOf = (el) => {
      const out = [];
      for (let n = el; n && n.nodeType === 1; n = composedParent(n)) if (s.known.has(n)) out.push(s.ids.get(n));
      return out;
    };
    const idsOf = (list) => list.filter((el) => el && s.known.has(el)).map((el) => s.ids.get(el));
    const alphaOf = (c) => {
      if (!c || c === "transparent") return 0;
      const slash = c.lastIndexOf("/");
      if (slash >= 0) return parseFloat(c.slice(slash + 1));
      const m = /^rgba\((.*)\)$/.exec(c);
      return m ? parseFloat(m[1].split(",")[3]) : 1;
    };
    const clearList = () => {
      const box = s.video.getBoundingClientRect();
      const v = { left: Math.max(box.left, 0), top: Math.max(box.top, 0), right: Math.min(box.right, innerWidth), bottom: Math.min(box.bottom, innerHeight) };
      const area = Math.max(0, v.right - v.left) * Math.max(0, v.bottom - v.top);
      const out = [];
      if (area < 1) return out;
      const visit = (el) => {
        if (el.nodeType !== 1 || !s.known.has(el)) return;
        if (el.offsetWidth * el.offsetHeight >= area * COVER || el === s.root) {
          const r = el.getBoundingClientRect();
          const w = Math.min(r.right, v.right) - Math.max(r.left, v.left);
          const h = Math.min(r.bottom, v.bottom) - Math.max(r.top, v.top);
          if (w > 0 && h > 0 && w * h >= area * COVER && alphaOf(getComputedStyle(el).backgroundColor) >= 0.98) out.push(s.ids.get(el));
        }
        for (let c = el.firstElementChild; c; c = c.nextElementSibling) visit(c);
        const root = shadowOf(el);
        if (root) for (let c = root.firstElementChild; c; c = c.nextElementSibling) visit(c);
      };
      visit(s.root);
      return out;
    };
    const deepFullscreen = () => {
      let el = document.fullscreenElement;
      for (let depth = 0; el && depth < 32; depth++) {
        const root = shadowOf(el);
        const inner = root && root.fullscreenElement;
        if (!inner) break;
        el = inner;
      }
      return el;
    };
    const matching = (selector) => {
      try {
        return [...s.root.querySelectorAll(selector)];
      } catch (e) {
        return [];
      }
    };
    const stateOps = (ops) => {
      const focused = deepActive();
      let visible = false;
      try {
        visible = !!focused && focused.matches(":focus-visible");
      } catch (e) {}
      const lists = {
        hover: chainOf(pointed()),
        active: s.pressed ? s.pressed : [],
        focus: idsOf([focused]),
        "focus-within": chainOf(focused),
        "focus-visible": visible ? idsOf([focused]) : [],
        fullscreen: idsOf([deepFullscreen()]),
        "popover-open": idsOf(matching(":popover-open")),
        modal: idsOf(matching(":modal")),
        clear: s.clear,
      };
      for (const k of STATES) {
        const joined = lists[k].join(",");
        if (s.stateSent.get(k) === joined) continue;
        s.stateSent.set(k, joined);
        ops.push({ o: "st", k, l: lists[k] });
      }
    };
    const round = (v) => Math.round(v * 100) / 100;
    const frameOp = (ops) => {
      const r = s.root.getBoundingClientRect();
      const f = { o: "f", x: round(r.left), y: round(r.top), w: round(r.width), h: round(r.height), vw: innerWidth, vh: innerHeight, dpr: devicePixelRatio };
      const joined = [f.x, f.y, f.w, f.h, f.vw, f.vh, f.dpr].join(",");
      if (s.frameSent === joined) return;
      if (!s.frameSent || !s.frameSent.endsWith("," + f.vw + "," + f.vh + "," + f.dpr)) send("videoMirror", { op: "frame", dpr: f.dpr, vw: f.vw, vh: f.vh });
      s.frameSent = joined;
      ops.push(f);
    };

    const ship = (batch) => {
      const text = toJSON(batch);
      if (text.length > BATCH_CHARS) return stop();
      const seq = ++s.seq;
      const parts = [];
      for (let at = 0; at < text.length; ) {
        let len = Math.min(PART_CHARS, text.length - at);
        for (;;) {
          const code = text.charCodeAt(at + len - 1);
          if (at + len < text.length && code >= 0xd800 && code <= 0xdbff) len--;
          const chunk = text.slice(at, at + len);
          const escaped = toJSON(chunk);
          if (len <= 64 || escaped.length * 3 <= PART_BYTES || encoder.encode(escaped).length <= PART_BYTES) break;
          len >>= 1;
        }
        parts.push(text.slice(at, at + len));
        at += len;
      }
      for (let part = 0; part < parts.length; part++) send("videoMirror", { op: "part", seq, part, parts: parts.length, data: parts[part] });
    };
    const resetTracking = () => {
      s.known = new WeakSet();
      s.dirtyChildren.clear();
      s.dirtyAttrs.clear();
      s.dirtyText.clear();
      s.dirtyValues.clear();
      s.dirtyScroll.clear();
      s.removed.clear();
      s.newShadows.clear();
      unwatchShadows(s);
      s.sheetSigs.clear();
      s.sheetLists.clear();
      s.stateSent.clear();
      s.frameSent = "";
      s.observer.disconnect();
    };
    const snapshot = () => {
      const t0 = now();
      const root = pickRoot(s.video);
      if (!root) return stop();
      if (root !== s.root) {
        if (s.resizer) s.resizer.disconnect();
        s.root = root;
        if (s.resizer) s.resizer.observe(root);
      }
      resetTracking();
      s.overlays = overlaysOf(root);
      s.sentValues = new WeakMap();
      const fresh = new Set();
      const shellNodes = shellsOf(root);
      s.shellChain = shellNodes;
      const shells = shellNodes.map((n) => ({ i: remember(n, fresh), t: n.localName, a: attrsOf(n) }));
      s.observer.observe(root, options);
      for (const o of s.overlays) s.observer.observe(o, options);
      for (const n of shellNodes) s.observer.observe(n, { attributes: true });
      if (document.head) s.observer.observe(document.head, { childList: true, subtree: true, characterData: true });
      const tree = describe(root, fresh);
      const pre = [];
      syncSheets(pre);
      s.clear = clearList();
      const ops = [];
      stateOps(ops);
      frameOp(ops);
      ship({ t: "s", pre, shells, root: tree, ops, pm: round(now() - t0), pt: Date.now() });
    };
    const childOp = (parent, fresh, ops) => {
      if (parent.nodeType === 11) {
        const host = parent.host;
        if (host && s.known.has(host) && !fresh.has(host)) ops.push({ o: "c", i: s.ids.get(host), s: 1, c: childrenOf(parent, fresh) });
        return;
      }
      if (!s.known.has(parent) || fresh.has(parent) || MEDIA.has(parent.localName) || BLANKED.has(parent.localName)) return;
      if (s.shellChain.includes(parent)) return;
      ops.push({ o: "c", i: s.ids.get(parent), c: childrenOf(parent, fresh) });
    };
    const inRoot = (n) => {
      for (let x = n; x; x = composedParent(x)) if (x === s.root || s.overlays.includes(x)) return true;
      return false;
    };
    const flush = () => {
      s.queued = false;
      if (!s.video.isConnected) return stop();
      const shells = shellsOf(s.root);
      if (!s.root.isConnected || !composedContains(s.root, s.video) || shells.length !== s.shellChain.length || shells.some((n, i) => n !== s.shellChain[i]))
        return snapshot();
      const t0 = now();
      syncOverlays();
      if (s.slowDue) pollOverlayValues();
      const fresh = new Set();
      const pre = [];
      const ops = [];
      for (const host of s.newShadows) {
        const root = shadowOf(host);
        if (root && s.known.has(host) && !fresh.has(host)) ops.push({ o: "sr", i: s.ids.get(host), sh: describeShadow(root, fresh) });
      }
      s.newShadows.clear();
      for (const parent of s.dirtyChildren) childOp(parent, fresh, ops);
      for (const el of s.dirtyAttrs) if (s.known.has(el) && !fresh.has(el)) ops.push({ o: "a", i: s.ids.get(el), a: attrsOf(el) });
      for (const t of s.dirtyText) if (s.known.has(t) && !fresh.has(t)) ops.push({ o: "x", i: s.ids.get(t), x: t.data });
      for (const el of s.dirtyValues) if (s.known.has(el)) ops.push({ o: "v", i: s.ids.get(el), ...formState(el, {}) });
      for (const el of s.dirtyScroll) if (s.known.has(el)) ops.push({ o: "sc", i: s.ids.get(el), x: el.scrollLeft, y: el.scrollTop });
      for (const n of s.removed) if (!inRoot(n)) forget(n);
      s.dirtyChildren.clear();
      s.dirtyAttrs.clear();
      s.dirtyText.clear();
      s.dirtyValues.clear();
      s.dirtyScroll.clear();
      s.removed.clear();
      syncSheets(pre);
      if (s.slowDue) {
        s.slowDue = false;
        s.clear = clearList();
      }
      stateOps(ops);
      frameOp(ops);
      if (!pre.length && !ops.length) return;
      ship({ t: "p", pre, ops, pm: round(now() - t0), pt: Date.now() });
    };
    const schedule = () => {
      if (!s || s.queued) return;
      s.queued = true;
      apply(frameLater, window, [guard(() => s && flush())]);
    };

    const onRecords = (records) => {
      if (!s) return;
      for (const r of records) {
        if (r.type === "childList") {
          s.dirtyChildren.add(r.target);
          for (const n of r.removedNodes) s.removed.add(n);
        } else if (r.type === "attributes") s.dirtyAttrs.add(r.target);
        else if (r.type === "characterData") s.dirtyText.add(r.target);
      }
      schedule();
    };
    const eventTarget = (e) => {
      const path = e.composedPath();
      return path.length ? path[0] : e.target;
    };
    const listeners = {
      pointermove: (e) => {
        s.pointer = { x: e.clientX, y: e.clientY };
        schedule();
      },
      pointerdown: (e) => {
        s.pointer = { x: e.clientX, y: e.clientY };
        s.pressed = chainOf(pointed());
        schedule();
      },
      pointerup: () => {
        s.pressed = null;
        schedule();
      },
      pointercancel: () => {
        s.pressed = null;
        schedule();
      },
      mouseout: (e) => {
        if (e.relatedTarget) return;
        s.pointer = null;
        schedule();
      },
      input: (e) => {
        s.dirtyValues.add(eventTarget(e));
        schedule();
      },
      change: (e) => {
        s.dirtyValues.add(eventTarget(e));
        schedule();
      },
      scroll: (e) => {
        const target = eventTarget(e);
        if (target && target.nodeType === 1) s.dirtyScroll.add(target);
        schedule();
      },
      focusin: () => schedule(),
      focusout: () => schedule(),
      keydown: () => schedule(),
      fullscreenchange: () => schedule(),
      resize: () => schedule(),
    };
    const start = (video) => {
      if (!video || video.localName !== "video") return;
      if (s && s.video === video) return;
      if (!video.isConnected) return;
      if (s) stop();
      s = {
        video,
        root: null,
        overlays: [],
        sentValues: new WeakMap(),
        idSeq: 0,
        ids: new WeakMap(),
        known: new WeakSet(),
        shellChain: [],
        dirtyChildren: new Set(),
        dirtyAttrs: new Set(),
        dirtyText: new Set(),
        dirtyValues: new Set(),
        dirtyScroll: new Set(),
        removed: new Set(),
        newShadows: new Set(),
        shadows: new Set(),
        sheetSigs: new Map(),
        sheetLists: new Map(),
        stateSent: new Map(),
        frameSent: "",
        clear: [],
        pointer: null,
        pressed: null,
        queued: false,
        slowDue: false,
        seq: 0,
        observer: new MO(guard(onRecords)),
        resizer: RO ? new RO(guard(() => schedule())) : null,
        timer: 0,
      };
      for (const type of keys(listeners)) window.addEventListener(type, listeners[type], { capture: true, passive: true });
      s.timer = apply(repeat, window, [
        guard(() => {
          if (!s) return;
          s.slowDue = true;
          schedule();
        }),
        SLOW_MS,
      ]);
      guard(snapshot)();
      captionRelayout.start();
    };
    const stop = () => {
      if (!s) return;
      const was = s;
      s = null;
      captionRelayout.stop();
      was.observer.disconnect();
      unwatchShadows(was);
      if (was.resizer) was.resizer.disconnect();
      apply(unrepeat, window, [was.timer]);
      for (const type of keys(listeners)) window.removeEventListener(type, listeners[type], { capture: true });
      send("videoMirror", { op: "stop" });
    };
    const startOnPlay = (e) => {
      const target = e.target;
      if (testMode && target && target.localName === "video" && (!s || !s.video.isConnected)) start(target);
    };
    handlers.videoMirror = (message) => {
      if (!message) return;
      if (message.test && !testMode) {
        testMode = true;
        document.addEventListener("playing", startOnPlay, true);
        const playing = [...document.querySelectorAll("video")].find((v) => !v.paused);
        if (playing) start(playing);
      }
      if (message.resync && s) snapshot();
    };
    const ensure = (video) => {
      if (s || !video || !video.isConnected) return;
      if (video !== retryVideo) {
        retryVideo = video;
        retries = 0;
        retryAt = 0;
      }
      if (retries >= RETRY_LIMIT || now() - retryAt < RETRY_MS) return;
      retries++;
      retryAt = now();
      start(video);
    };
    const prepare = () => {
      if (s || !MIRROR_ORIGINS.includes(location.origin)) return;
      send("videoMirror", { op: "frame", dpr: devicePixelRatio, vw: innerWidth, vh: innerHeight });
    };
    return { start: guard(start), ensure: guard(ensure), stop: guard(stop), prepare: guard(prepare) };
  })();
  let bridgesProtectedPlayback = () => false;
  let reportProtectedPlayback = null;
  const PROTECTED_VIDEO_ORIGINS = ["https://www.netflix.com", "https://www.disneyplus.com"];
  const PROTECTED_VIDEO_ON = false;
  const FAIRPLAY_ORIGINS = ["https://open.spotify.com", "https://www.netflix.com", "https://www.disneyplus.com"];
  try {
    if (isTop && FAIRPLAY_ORIGINS.includes(location.origin) && !PROTECTED_VIDEO_ORIGINS.includes(location.origin) && typeof Navigator.prototype.requestMediaKeySystemAccess === "function") {
      const KEY_SYSTEM = "com.apple.fps.1_0";
      const PLAYLIST_PART = 30000;
      const CONFIG_WAIT_MS = 3000;
      const SEEK_GIVE_UP_MS = 2000;
      const ENCRYPTED_DELAY_MS = 100;
      const TICK_MS = 250;
      const READY_GIVE_UP_MS = 45000;
      const PLAYLIST_URL = /^data:application\/(?:vnd\.apple\.mpegurl|x-mpegurl)((?:;[^,]*)?),/i;
      const Media = HTMLMediaElement.prototype;
      const { defineProperty, getOwnPropertyDescriptor } = Object;
      const { btoa, atob } = window;
      const fromCharCode = String.fromCharCode;
      const clock = performance;
      const clockNow = clock.now;
      const now = () => apply(clockNow, clock, []);
      const encoder = new TextEncoder();
      let enabled = null;
      const awaitingConfig = [];
      const configureFairPlay = (on) => {
        enabled = on;
        for (const resolve of awaitingConfig.splice(0)) resolve();
      };
      const whenConfigured = () =>
        enabled !== null
          ? Promise.resolve()
          : new Promise((resolve) => {
              awaitingConfig.push(resolve);
              setTimeout(resolve, CONFIG_WAIT_MS);
            });
      const bytesOf = (b) =>
        b instanceof ArrayBuffer ? new Uint8Array(b) : ArrayBuffer.isView(b) ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : new Uint8Array(0);
      const toBase64 = (bytes) => {
        let text = "";
        for (let i = 0; i < bytes.length; i += 0x8000) text += apply(fromCharCode, null, bytes.subarray(i, i + 0x8000));
        return btoa(text);
      };
      const fromBase64 = (text) => {
        const binary = atob(text);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
      };
      const fire = (el, type) => el.dispatchEvent(new Event(type));

      let certificate = "";
      let generation = 0;
      let media = null;
      let pending = null;
      let request = null;
      let ticker = 0;
      const tracks = new WeakMap();
      const ownKeys = new WeakSet();
      const keysOf = new WeakMap();
      const everKeyed = new WeakSet();
      let keyed = null;
      const sessionGeneration = new WeakMap();
      bridgesProtectedPlayback = () => {
        const t = media && tracks.get(media);
        return !!t && !t.failed;
      };

      const deliverRequest = () => {
        if (!pending || !request || sessionGeneration.get(pending) !== request.gen) return;
        const target = pending;
        const { message } = request;
        request = null;
        let event;
        try {
          event = new MediaKeyMessageEvent("message", { messageType: "license-request", message });
        } catch (e) {
          event = new Event("message");
          event.messageType = "license-request";
          event.message = message;
        }
        target.dispatchEvent(event);
      };
      const createSession = () => {
        const keySession = new EventTarget();
        keySession.sessionId = "ardia-" + Math.random().toString(36).slice(2);
        keySession.expiration = NaN;
        keySession.keyStatuses = new Map();
        let closeSession;
        keySession.closed = new Promise((resolve) => (closeSession = resolve));
        keySession.generateRequest = () => {
          sessionGeneration.set(keySession, generation);
          pending = keySession;
          deliverRequest();
          return Promise.resolve();
        };
        keySession.update = (response) => {
          send("fairPlay", { op: "license", gen: sessionGeneration.get(keySession), ckc: toBase64(bytesOf(response)) });
          keySession.keyStatuses = new Map([[new Uint8Array(16).buffer, "usable"]]);
          keySession.dispatchEvent(new Event("keystatuseschange"));
          return Promise.resolve();
        };
        keySession.load = () => Promise.resolve(false);
        keySession.close = () => {
          closeSession();
          return Promise.resolve();
        };
        keySession.remove = () => Promise.resolve();
        return keySession;
      };
      const createKeys = () => {
        const keys = {
          setServerCertificate(server) {
            const bytes = bytesOf(server);
            if (bytes.length) certificate = toBase64(bytes);
            return Promise.resolve(true);
          },
          createSession,
          getStatusForPolicy: () => Promise.resolve("usable"),
        };
        ownKeys.add(keys);
        return keys;
      };

      const requestAccess = Navigator.prototype.requestMediaKeySystemAccess;
      defineProperty(Navigator.prototype, "requestMediaKeySystemAccess", {
        ...getOwnPropertyDescriptor(Navigator.prototype, "requestMediaKeySystemAccess"),
        value: asNative(requestAccess, (target, self, args) => {
          if (args[0] !== KEY_SYSTEM) {
            if (!/^com\.(?:widevine|microsoft\.playready)(?:\.|$)/.test(String(args[0]))) return apply(target, self, args);
            return whenConfigured().then(() =>
              enabled === true
                ? Promise.reject(new DOMException("Unsupported keySystem or supportedConfigurations.", "NotSupportedError"))
                : apply(target, self, args)
            );
          }
          const configurations = args[1];
          return whenConfigured().then(() => {
            if (enabled !== true) return apply(target, self, args);
            const configuration = (configurations && configurations[0]) || {};
            return { keySystem: KEY_SYSTEM, getConfiguration: () => configuration, createMediaKeys: () => Promise.resolve(createKeys()) };
          });
        }),
      });
      const mediaKeys = getOwnPropertyDescriptor(Media, "mediaKeys");
      defineProperty(Media, "mediaKeys", {
        ...mediaKeys,
        get() {
          return keysOf.has(this) ? keysOf.get(this) : apply(mediaKeys.get, this, []);
        },
      });
      const setMediaKeys = Media.setMediaKeys;
      Media.setMediaKeys = asNative(setMediaKeys, (target, self, args) => {
        if (ownKeys.has(args[0])) {
          keysOf.set(self, args[0]);
          everKeyed.add(self);
          keyed = self;
          return Promise.resolve();
        }
        keysOf.delete(self);
        return apply(target, self, args);
      });

      const positionOf = (t) =>
        t.paused || !t.playing ? t.time : Math.min(Number.isNaN(t.duration) ? Infinity : t.duration, t.time + (now() - t.stamp) / 1000);
      const rangesOf = (t) => ({ length: t.ready ? 1 : 0, start: () => 0, end: () => (Number.isNaN(t.duration) ? 0 : t.duration) });
      const stopTicking = () => {
        if (ticker) clearInterval(ticker);
        ticker = 0;
      };
      const startTicking = () => {
        if (ticker) return;
        ticker = setInterval(
          guard(() => {
            const t = media && tracks.get(media);
            if (t && !t.paused) fire(media, "timeupdate");
            else stopTicking();
          }),
          TICK_MS
        );
      };
      const finishSeek = (t, el) => {
        t.seeking = 0;
        fire(el, "seeked");
        fire(el, "timeupdate");
      };
      const drives = (t) => !t.detached && !t.failed;
      const seek = (t, el, value) => {
        const time = +value;
        if (!isFinite(time) || time < 0) return;
        t.time = time;
        t.stamp = now();
        t.ended = false;
        if (!drives(t)) {
          fire(el, "seeking");
          fire(el, "seeked");
          fire(el, "timeupdate");
          return;
        }
        const seq = ++t.seeks;
        t.seeking = seq;
        send("fairPlay", { op: "seek", time, seq });
        fire(el, "seeking");
        setTimeout(
          guard(() => {
            if (t.seeking === seq) finishSeek(t, el);
          }),
          SEEK_GIVE_UP_MS
        );
      };
      const natives = {};
      const override = (name, get, set) => {
        const native = getOwnPropertyDescriptor(Media, name);
        if (!native || !native.get) return;
        natives[name] = native;
        defineProperty(Media, name, {
          ...native,
          get() {
            const t = tracks.get(this);
            return t ? get(t) : apply(native.get, this, []);
          },
          set: native.set
            ? function (value) {
                const t = tracks.get(this);
                if (t && set) set(t, this, value);
                else apply(native.set, this, [value]);
              }
            : undefined,
        });
      };
      override("readyState", (t) => t.ready);
      override("networkState", (t) => (t.ready ? 1 : 2));
      override("duration", (t) => t.duration);
      override("paused", (t) => t.paused);
      override("ended", (t) => t.ended);
      override("error", (t) => t.error);
      override("buffered", rangesOf);
      override("seekable", rangesOf);
      override("webkitAudioDecodedByteCount", (t) => (t.ready ? 1 : 0));
      override("currentTime", positionOf, seek);
      override("volume", (t) => t.volume, (t, el, value) => {
        const volume = Math.min(Math.max(+value || 0, 0), 1);
        t.volume = volume;
        if (drives(t)) send("fairPlay", { op: "volume", volume });
        fire(el, "volumechange");
      });
      override("muted", (t) => t.muted, (t, el, value) => {
        t.muted = !!value;
        if (drives(t)) send("fairPlay", { op: "muted", muted: t.muted });
        fire(el, "volumechange");
      });
      const nativeValue = (el, name, fallback) => {
        try {
          return apply(natives[name].get, el, []);
        } catch (e) {
          return fallback;
        }
      };

      const playMedia = Media.play;
      Media.play = asNative(playMedia, (target, self, args) => {
        const t = tracks.get(self);
        if (!t) return apply(target, self, args);
        trackDetachedMedia(self);
        if (t.paused && blockAutoplay && !askedToPlay()) return Promise.reject(autoplayRefusal());
        if (t.failed) return Promise.reject(new DOMException("The element has no supported sources.", "NotSupportedError"));
        if (t.detached) {
          attach(self, t);
          if (t.time > 0 || t.seeks) send("fairPlay", { op: "seek", time: t.time, seq: ++t.seeks });
        }
        if (t.paused) {
          if (t.ended) seek(t, self, 0);
          t.paused = false;
          t.ended = false;
          t.stamp = now();
          send("fairPlay", { op: "play" });
          fire(self, "play");
          startTicking();
        }
        return Promise.resolve();
      });
      const pauseMedia = Media.pause;
      Media.pause = asNative(pauseMedia, (target, self, args) => {
        const t = tracks.get(self);
        if (!t) return apply(target, self, args);
        if (t.paused) return;
        t.time = positionOf(t);
        t.paused = true;
        t.playing = false;
        send("fairPlay", { op: "pause" });
        fire(self, "pause");
      });
      const loadMedia = Media.load;
      Media.load = asNative(loadMedia, (target, self, args) => (tracks.has(self) ? undefined : apply(target, self, args)));

      const sendMetadata = () => {
        if (!media) return;
        const md = session && session.metadata;
        send("fairPlay", { op: "metadata", title: (md && md.title) || "", artist: (md && md.artist) || "", album: (md && md.album) || "", artwork: artworkOf(md) || "" });
      };
      const sessionProto = session && Object.getPrototypeOf(session);
      const metadata = sessionProto && getOwnPropertyDescriptor(sessionProto, "metadata");
      if (metadata && metadata.set)
        defineProperty(sessionProto, "metadata", {
          ...metadata,
          set(value) {
            apply(metadata.set, this, [value]);
            guard(sendMetadata)();
          },
        });

      const encryptedEvent = (skd) => {
        const event = new Event("encrypted");
        event.initDataType = "cbcs";
        event.initData = encoder.encode(skd);
        event.fromPolyfill = true;
        return event;
      };
      const bridge = (el, value) => {
        if (enabled !== true || !el || !everKeyed.has(el)) return false;
        const url = String(value);
        const head = url.match(PLAYLIST_URL);
        if (!head) return false;
        let playlist;
        try {
          playlist = /;base64/i.test(head[1]) ? atob(url.slice(head[0].length)) : decodeURIComponent(url.slice(head[0].length));
        } catch (e) {
          return false;
        }
        const skd = (playlist.match(/URI="(skd:\/\/[^"]+)"/) || [])[1];
        if (!/^#EXTM3U/.test(playlist) || !skd || !certificate) return false;
        const previous = tracks.get(el);
        if (media && media !== el) release(media);
        const t = {
          gen: 0,
          playlist,
          cert: certificate,
          loaded: false,
          detached: false,
          ready: 0,
          time: 0,
          stamp: now(),
          duration: NaN,
          paused: true,
          playing: false,
          ended: false,
          error: null,
          failed: false,
          seeks: 0,
          seeking: 0,
          volume: previous ? previous.volume : nativeValue(el, "volume", 1),
          muted: previous ? previous.muted : nativeValue(el, "muted", false),
        };
        tracks.set(el, t);
        stopTicking();
        attach(el, t);
        setTimeout(
          guard(() => {
            if (tracks.get(el) === t) el.dispatchEvent(encryptedEvent(skd));
          }),
          ENCRYPTED_DELAY_MS
        );
        return true;
      };
      const parentMedia = (source) => (source.parentElement instanceof HTMLMediaElement ? source.parentElement : null);
      const sourceSrc = getOwnPropertyDescriptor(HTMLSourceElement.prototype, "src");
      defineProperty(HTMLSourceElement.prototype, "src", {
        ...sourceSrc,
        set(value) {
          if (guard(bridge)(parentMedia(this) || keyed, value)) return;
          guard(unbridge)(parentMedia(this));
          apply(sourceSrc.set, this, [value]);
        },
      });
      const mediaSrc = getOwnPropertyDescriptor(Media, "src");
      defineProperty(Media, "src", {
        ...mediaSrc,
        set(value) {
          if (guard(bridge)(this, value)) return;
          guard(unbridge)(this);
          apply(mediaSrc.set, this, [value]);
        },
      });
      const srcObject = getOwnPropertyDescriptor(Media, "srcObject");
      if (srcObject && srcObject.set)
        defineProperty(Media, "srcObject", {
          ...srcObject,
          set(value) {
            guard(unbridge)(this);
            apply(srcObject.set, this, [value]);
          },
        });
      const ElementProto = Element.prototype;
      const isSrc = (name) => typeof name === "string" && name.toLowerCase() === "src";
      defineProperty(Media, "setAttribute", {
        ...getOwnPropertyDescriptor(ElementProto, "setAttribute"),
        value: asNative(ElementProto.setAttribute, (target, self, args) => {
          if (isSrc(args[0])) {
            if (guard(bridge)(self, args[1])) return;
            guard(unbridge)(self);
          }
          return apply(target, self, args);
        }),
      });
      defineProperty(Media, "removeAttribute", {
        ...getOwnPropertyDescriptor(ElementProto, "removeAttribute"),
        value: asNative(ElementProto.removeAttribute, (target, self, args) => {
          if (isSrc(args[0])) guard(unbridge)(self);
          return apply(target, self, args);
        }),
      });

      function attach(el, t) {
        const previousGen = t.gen;
        const gen = ++generation;
        t.gen = gen;
        t.detached = false;
        t.loaded = false;
        if (previousGen && pending && sessionGeneration.get(pending) === previousGen) sessionGeneration.set(pending, gen);
        media = el;
        request = null;
        const { playlist } = t;
        const parts = Math.max(1, Math.ceil(playlist.length / PLAYLIST_PART));
        for (let part = 0; part < parts; part++) {
          const chunk = playlist.slice(part * PLAYLIST_PART, (part + 1) * PLAYLIST_PART);
          send("fairPlay", { op: "load", gen, part, parts, playlist: chunk, cert: part === 0 ? t.cert : null, volume: t.volume, muted: t.muted });
        }
        sendMetadata();
        setTimeout(
          guard(() => {
            if (tracks.get(el) === t && t.gen === gen && !t.loaded && !t.detached) fail(el, t);
          }),
          READY_GIVE_UP_MS
        );
      }
      function release(el) {
        const t = tracks.get(el);
        if (!t) return;
        t.detached = true;
        if (t.paused) return;
        t.time = positionOf(t);
        t.paused = true;
        t.playing = false;
        stopTicking();
        fire(el, "pause");
      }
      function unbridge(el) {
        if (!el || !tracks.has(el)) return;
        tracks.delete(el);
        if (media === el) {
          media = null;
          request = null;
          stopTicking();
          send("fairPlay", { op: "stop" });
        }
        fire(el, "emptied");
      }
      const fail = (el, t) => {
        if (t.failed) return;
        if (media === el && drives(t)) {
          request = null;
          send("fairPlay", { op: "stop" });
        }
        t.failed = true;
        t.playing = false;
        t.paused = true;
        stopTicking();
        t.error = { code: 3, message: "Protected playback failed", MEDIA_ERR_ABORTED: 1, MEDIA_ERR_NETWORK: 2, MEDIA_ERR_DECODE: 3, MEDIA_ERR_SRC_NOT_SUPPORTED: 4 };
        fire(el, "error");
        if (reportProtectedPlayback) reportProtectedPlayback(KEY_SYSTEM);
      };
      const remote = (command, time) => {
        const t = media && tracks.get(media);
        const action = command === "toggle" ? (t && !t.paused ? "pause" : "play") : command;
        const handler = actions.get(action);
        if (handler) return handler(action === "seekto" ? { action, seekTime: time } : { action });
        if (!media) return;
        if (action === "play") media.play();
        else if (action === "pause") media.pause();
        else if (action === "seekto" && isFinite(time)) media.currentTime = time;
      };
      handlers.fairPlay = (m) => {
        if (m.event === "config") return configureFairPlay(m.on === true);
        if (m.event === "remote") return remote(m.command, m.time);
        const el = media;
        const t = el && tracks.get(el);
        if (!t || m.gen !== t.gen || t.failed) return;
        if (m.event === "request") {
          request = { gen: m.gen, message: fromBase64(m.spc).buffer };
          deliverRequest();
        } else if (m.event === "ready") {
          t.loaded = true;
          t.duration = m.duration;
          t.ready = 4;
          for (const type of ["loadedmetadata", "durationchange", "loadeddata", "canplay", "canplaythrough"]) fire(el, type);
        } else if (m.event === "position") {
          if (m.seq < t.seeks) return;
          t.time = m.time;
          t.stamp = now();
          if (t.seeking) finishSeek(t, el);
          const was = t.playing;
          t.playing = !!m.playing && !t.paused;
          if (t.playing && !was) fire(el, "playing");
          else if (was && !t.playing && !t.paused) fire(el, "waiting");
        } else if (m.event === "ended") {
          if (!Number.isNaN(t.duration)) t.time = t.duration;
          t.playing = false;
          t.paused = true;
          t.ended = true;
          stopTicking();
          fire(el, "timeupdate");
          fire(el, "pause");
          fire(el, "ended");
        } else if (m.event === "failed") {
          fail(el, t);
        } else if (m.event === "stolen") {
          release(el);
        }
      };
      addEventListener(
        "pagehide",
        guard((e) => {
          if (!e.isTrusted || !media) return;
          send("fairPlay", { op: "stop" });
          release(media);
        })
      );
    }
  } catch (e) {}
  try {
    if (isTop && PROTECTED_VIDEO_ON && PROTECTED_VIDEO_ORIGINS.includes(location.origin) && window.MediaSource) {
      bridgesProtectedPlayback = () => true;
      const SAFARI_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15";
      const PLAYER_ROUTE = location.origin === "https://www.netflix.com" ? /^\/watch\// : /^\/play\//;
      const UNDECODABLE = /av01|vp0?9|dvh1|dvhe|dav1/i;
      const FAIRPLAY = /^com\.apple\.fps/;
      const OTHER_KEY_SYSTEMS = /^com\.(widevine|microsoft|chromecast|youtube)/;
      const PART_BYTES = 45000;
      const MAX_KEY_BYTES = 45000;
      const MAX_PENDING_BYTES = 64e6;
      const MAX_BUFFER_ID = 64;
      const TICK_MS = 250;
      const FRAME_RATE = 24;
      const KEY_WAIT_MS = 15000;
      const AHEAD_LIMIT_S = 1;
      const KEEP_BEHIND_S = 5;
      const VIDEO_QUOTA = 200e6;
      const AUDIO_QUOTA = 24e6;
      const { defineProperty, getOwnPropertyDescriptor, create } = Object;
      const fromCharCode = String.fromCharCode;
      const { btoa, atob } = window;
      const clock = performance;
      const clockNow = clock.now;
      const now = () => apply(clockNow, clock, []);
      const soon = (fn, ms) => setTimeout(guard(fn), ms);
      const face = { userAgent: SAFARI_UA, appVersion: SAFARI_UA.slice(8), vendor: "Apple Computer, Inc.", platform: "MacIntel", userAgentData: undefined };
      for (const name of keys(face)) {
        const was = getOwnPropertyDescriptor(Navigator.prototype, name);
        if (was && was.get) defineProperty(Navigator.prototype, name, { ...was, get: asNative(was.get, () => face[name]) });
      }
      try {
        delete window.chrome;
      } catch (e) {}

      const mp4 = (() => {
        const fourcc = (u, i) => String.fromCharCode(u[i], u[i + 1], u[i + 2], u[i + 3]);
        const viewOf = (u) => new DataView(u.buffer, u.byteOffset, u.byteLength);
        const boxes = (u, start, end) => {
          const view = viewOf(u);
          const found = [];
          let at = start;
          while (at + 8 <= end) {
            let size = view.getUint32(at);
            let header = 8;
            if (size === 1) {
              if (at + 16 > end) break;
              size = view.getUint32(at + 8) * 4294967296 + view.getUint32(at + 12);
              header = 16;
            } else if (size === 0) size = end - at;
            if (size < header || at + size > end) break;
            found.push({ type: fourcc(u, at + 4), start: at, body: at + header, end: at + size });
            at += size;
          }
          return found;
        };
        const child = (u, box, type) => box && boxes(u, box.body, box.end).find((b) => b.type === type);
        const describeInit = (u) => {
          const view = viewOf(u);
          const info = { timescale: 1, sampleDuration: 0, width: 0, height: 0, duration: 0 };
          const moov = boxes(u, 0, u.length).find((b) => b.type === "moov");
          const trak = child(u, moov, "trak");
          const tkhd = child(u, trak, "tkhd");
          if (tkhd) {
            const at = tkhd.body + (u[tkhd.body] === 1 ? 88 : 76);
            if (at + 8 <= tkhd.end) {
              info.width = view.getUint32(at) >>> 16;
              info.height = view.getUint32(at + 4) >>> 16;
            }
          }
          const mdhd = child(u, child(u, trak, "mdia"), "mdhd");
          if (mdhd) info.timescale = view.getUint32(mdhd.body + (u[mdhd.body] === 1 ? 20 : 12)) || 1;
          const trex = child(u, child(u, moov, "mvex"), "trex");
          if (trex) info.sampleDuration = view.getUint32(trex.body + 12);
          const wideAt = (at) => view.getUint32(at) * 4294967296 + view.getUint32(at + 4);
          const mvhd = child(u, moov, "mvhd");
          if (mvhd && mvhd.body + 32 <= mvhd.end) {
            const wide = u[mvhd.body] === 1;
            const scale = view.getUint32(mvhd.body + (wide ? 20 : 12));
            const whole = wide ? wideAt(mvhd.body + 24) : view.getUint32(mvhd.body + 16);
            const mehd = child(u, child(u, moov, "mvex"), "mehd");
            const fragments = mehd && mehd.body + (u[mehd.body] === 1 ? 12 : 8) <= mehd.end ? (u[mehd.body] === 1 ? wideAt(mehd.body + 4) : view.getUint32(mehd.body + 4)) : 0;
            const unknown = (n) => n === 0xffffffff || n >= Number.MAX_SAFE_INTEGER;
            const longest = Math.max(unknown(whole) ? 0 : whole, unknown(fragments) ? 0 : fragments);
            if (scale && longest) info.duration = longest / scale;
          }
          return info;
        };
        const fragmentTimes = (u, info) => {
          const view = viewOf(u);
          let start = null;
          let duration = 0;
          for (const moof of boxes(u, 0, u.length)) {
            if (moof.type !== "moof") continue;
            const traf = child(u, moof, "traf");
            if (!traf) continue;
            let sampleDuration = info.sampleDuration;
            const tfhd = child(u, traf, "tfhd");
            if (tfhd) {
              const flags = view.getUint32(tfhd.body) & 0xffffff;
              let at = tfhd.body + 8;
              if (flags & 1) at += 8;
              if (flags & 2) at += 4;
              if (flags & 8) sampleDuration = view.getUint32(at);
            }
            const tfdt = child(u, traf, "tfdt");
            if (tfdt && start === null)
              start = u[tfdt.body] === 1 ? view.getUint32(tfdt.body + 4) * 4294967296 + view.getUint32(tfdt.body + 8) : view.getUint32(tfdt.body + 4);
            for (const trun of boxes(u, traf.body, traf.end)) {
              if (trun.type !== "trun") continue;
              const flags = view.getUint32(trun.body) & 0xffffff;
              const count = view.getUint32(trun.body + 4);
              if (!(flags & 0x100)) {
                duration += count * sampleDuration;
                continue;
              }
              let at = trun.body + 8 + (flags & 1 ? 4 : 0) + (flags & 4 ? 4 : 0);
              const stride = 4 + (flags & 0x200 ? 4 : 0) + (flags & 0x400 ? 4 : 0) + (flags & 0x800 ? 4 : 0);
              for (let k = 0; k < count && at + 4 <= trun.end; k++, at += stride) duration += view.getUint32(at);
            }
          }
          return start === null ? null : [start / info.timescale, (start + duration) / info.timescale];
        };
        const split = (u) => {
          const units = [];
          let lead = 0;
          let fragment = false;
          for (const box of boxes(u, 0, u.length)) {
            if (box.type === "moov") {
              units.push({ kind: "init", bytes: u.subarray(lead, box.end) });
              lead = box.end;
              fragment = false;
            } else if (box.type === "moof") {
              fragment = true;
            } else if (box.type === "mdat") {
              if (fragment) units.push({ kind: "segment", bytes: u.subarray(lead, box.end) });
              lead = box.end;
              fragment = false;
            }
          }
          return { units, rest: lead };
        };
        const merged = (segments) => {
          const out = [];
          for (const s of [...segments].sort((a, b) => a.start - b.start)) {
            const last = out[out.length - 1];
            if (last && s.start <= last[1] + 0.25) last[1] = Math.max(last[1], s.end);
            else out.push([s.start, s.end]);
          }
          return out;
        };
        const intersect = (a, b) => {
          const out = [];
          for (let i = 0, j = 0; i < a.length && j < b.length; ) {
            const start = Math.max(a[i][0], b[j][0]);
            const end = Math.min(a[i][1], b[j][1]);
            if (start < end) out.push([start, end]);
            if (a[i][1] < b[j][1]) i++;
            else j++;
          }
          return out;
        };
        return { boxes, describeInit, fragmentTimes, split, merged, intersect };
      })();

      const bytesOf = (b) =>
        b instanceof ArrayBuffer ? new Uint8Array(b) : ArrayBuffer.isView(b) ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : new Uint8Array(0);
      const toBase64 = (bytes) => {
        let text = "";
        for (let i = 0; i < bytes.length; i += 0x8000) text += apply(fromCharCode, null, bytes.subarray(i, i + 0x8000));
        return btoa(text);
      };
      const fromBase64 = (text) => {
        const binary = atob(text);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
      };
      const fire = (target, type) => target.dispatchEvent(new Event(type));
      const fireOwn = (target, type, event = new Event(type)) => {
        target.dispatchEvent(event);
        const handler = target["on" + type];
        if (typeof handler === "function") apply(handler, target, [event]);
      };
      const own = (target, values) => {
        for (const name of keys(values)) defineProperty(target, name, { value: values[name], writable: true, configurable: true, enumerable: true });
        return target;
      };
      const timeRanges = (list) => {
        const out = create(TimeRanges.prototype);
        const at = (i) => {
          if (!(i >= 0 && i < list.length)) throw new DOMException("The index provided is out of range.", "IndexSizeError");
          return list[i];
        };
        defineProperty(out, "length", { value: list.length });
        defineProperty(out, "start", { value: (i) => at(i)[0] });
        defineProperty(out, "end", { value: (i) => at(i)[1] });
        return out;
      };
      const unsupported = () => new DOMException("Unsupported keySystem or supportedConfigurations.", "NotSupportedError");

      const keySessions = new Map();
      const ownKeys = new WeakSet();
      const keysOf = new WeakMap();
      let keySessionSeq = 0;
      const makeKeySession = (keySystem) => {
        const id = ++keySessionSeq;
        const keySession = new EventTarget();
        setPrototypeOf(keySession, MediaKeySession.prototype);
        let closeSession;
        const entry = { keySession, waiting: [] };
        own(keySession, {
          sessionId: "",
          expiration: NaN,
          keyStatuses: new Map(),
          closed: new Promise((resolve) => (closeSession = resolve)),
          onmessage: null,
          onkeystatuseschange: null,
          generateRequest: (initDataType, initData) => {
            const data = bytesOf(initData);
            if (!data.length || data.length > MAX_KEY_BYTES) return Promise.reject(new TypeError("Invalid initData"));
            keySession.sessionId = "ardia-" + id;
            send("protectedVideo", { op: "request", session: id, keySystem, type: String(initDataType).slice(0, 16), data: toBase64(data) });
            return Promise.resolve();
          },
          update: (response) =>
            new Promise((resolve, reject) => {
              const data = bytesOf(response);
              if (!data.length || data.length > MAX_KEY_BYTES) return reject(new TypeError("Invalid response"));
              const waiter = { resolve, reject };
              entry.waiting.push(waiter);
              soon(() => {
                const at = entry.waiting.indexOf(waiter);
                if (at < 0) return;
                entry.waiting.splice(at, 1);
                resolve();
              }, KEY_WAIT_MS);
              send("protectedVideo", { op: "update", session: id, data: toBase64(data) });
            }),
          load: () => Promise.resolve(false),
          remove: () => Promise.resolve(),
          close: () => {
            if (keySessions.delete(id)) send("protectedVideo", { op: "closeSession", session: id });
            closeSession();
            return Promise.resolve();
          },
        });
        keySessions.set(id, entry);
        return keySession;
      };
      const makeKeys = (keySystem) => {
        const mediaKeys = own(create(MediaKeys.prototype), {
          setServerCertificate: (certificate) => {
            const data = bytesOf(certificate);
            if (!data.length || data.length > MAX_KEY_BYTES) return Promise.reject(new TypeError("Invalid certificate"));
            send("protectedVideo", { op: "certificate", data: toBase64(data) });
            return Promise.resolve(true);
          },
          createSession: () => makeKeySession(keySystem),
          getStatusForPolicy: () => Promise.resolve("usable"),
        });
        ownKeys.add(mediaKeys);
        return mediaKeys;
      };
      const keyAccess = (keySystem, configuration) =>
        own(create(MediaKeySystemAccess.prototype), {
          keySystem,
          getConfiguration: () => configuration,
          createMediaKeys: () => Promise.resolve(makeKeys(keySystem)),
        });
      const pickConfiguration = (configurations) => {
        for (const config of isArray(configurations) ? configurations : []) {
          const asked = isArray(config && config.videoCapabilities) ? config.videoCapabilities : [];
          const video = asked.filter((c) => !UNDECODABLE.test(String((c && c.contentType) || "")));
          if (asked.length && !video.length) continue;
          return {
            label: (config && config.label) || "",
            initDataTypes: isArray(config && config.initDataTypes) ? config.initDataTypes : ["cenc"],
            audioCapabilities: isArray(config && config.audioCapabilities) ? config.audioCapabilities : [],
            videoCapabilities: video,
            distinctiveIdentifier: "not-allowed",
            persistentState: "not-allowed",
            sessionTypes: ["temporary"],
          };
        }
        return null;
      };
      const requestAccess = Navigator.prototype.requestMediaKeySystemAccess;
      if (typeof requestAccess === "function")
        Navigator.prototype.requestMediaKeySystemAccess = asNative(requestAccess, (target, self, args) => {
          const keySystem = String(args[0]);
          if (FAIRPLAY.test(keySystem)) {
            const configuration = pickConfiguration(args[1]);
            return configuration ? Promise.resolve(keyAccess(keySystem, configuration)) : Promise.reject(unsupported());
          }
          if (OTHER_KEY_SYSTEMS.test(keySystem)) return Promise.reject(unsupported());
          return apply(target, self, args);
        });
      if (!window.WebKitMediaKeys) {
        const WebKitMediaKeys = function WebKitMediaKeys() {
          throw new TypeError("Illegal constructor");
        };
        WebKitMediaKeys.isTypeSupported = (keySystem, type) => FAIRPLAY.test(String(keySystem)) && !UNDECODABLE.test(String(type || ""));
        defineProperty(window, "WebKitMediaKeys", { value: WebKitMediaKeys, writable: true, configurable: true });
      }
      const capabilities = window.MediaCapabilities && MediaCapabilities.prototype;
      if (capabilities && typeof capabilities.decodingInfo === "function")
        capabilities.decodingInfo = asNative(capabilities.decodingInfo, (target, self, args) => {
          const config = args[0] || {};
          const refused = { supported: false, smooth: false, powerEfficient: false, keySystemAccess: null };
          if (config.video && UNDECODABLE.test(String(config.video.contentType || ""))) return Promise.resolve(refused);
          const keySystem = config.keySystemConfiguration && String(config.keySystemConfiguration.keySystem || "");
          if (keySystem && FAIRPLAY.test(keySystem)) {
            const configuration = {
              initDataTypes: [config.keySystemConfiguration.initDataType || "cenc"],
              videoCapabilities: config.video ? [{ contentType: config.video.contentType, robustness: "" }] : [],
              audioCapabilities: config.audio ? [{ contentType: config.audio.contentType, robustness: "" }] : [],
              distinctiveIdentifier: "not-allowed",
              persistentState: "not-allowed",
              sessionTypes: ["temporary"],
            };
            return Promise.resolve({ supported: true, smooth: true, powerEfficient: true, keySystemAccess: keyAccess(keySystem, configuration) });
          }
          if (keySystem) return Promise.resolve(refused);
          return apply(target, self, args);
        });
      const SourceType = window.MediaSource;
      SourceType.isTypeSupported = asNative(SourceType.isTypeSupported, (target, self, args) => !UNDECODABLE.test(String(args[0])) && apply(target, self, args));

      const Media = HTMLMediaElement.prototype;
      const Video = HTMLVideoElement.prototype;
      const bridgeOf = new WeakMap();
      const bridgeOfSource = new WeakMap();
      const sourceOfUrl = new Map();
      let bridged = null;
      let held = null;
      let mediaSeq = 0;
      const sendMedia = (b, data) => (b.held ? b.backlog.push(data) : send("protectedVideo", data));
      const bufferedOf = (b) => {
        const live = b.states.filter((st) => !st.removed);
        return live.length ? live.map((st) => mp4.merged(st.segments)).reduce(mp4.intersect) : [];
      };
      const holds = (b, time) => bufferedOf(b).some(([start, end]) => time >= start - 0.1 && time < end);
      const durationOf = (b) => {
        const duration = b.source.duration;
        return Number.isNaN(duration) && b.initDuration > 0 ? b.initDuration : duration;
      };
      const positionOf = (b) => {
        if (b.seeking) return b.seekTo;
        if (b.paused || !b.playing) return b.time;
        const duration = durationOf(b);
        return Math.min(b.time + ((now() - b.stamp) / 1000) * b.rate, b.time + AHEAD_LIMIT_S, isFinite(duration) ? duration : Infinity);
      };
      const sendDuration = (b) => {
        const duration = durationOf(b);
        const known = isFinite(duration) && duration > 0 ? duration : 0;
        if (known === b.sentDuration) return;
        b.sentDuration = known;
        sendMedia(b, { op: "duration", media: b.id, duration: known });
      };
      const startMirror = (b) => {
        if (typeof videoMirror === "undefined") return;
        const again = b.mirrored;
        b.mirrored = true;
        guard(() => (again ? videoMirror.ensure(b.el) : videoMirror.start(b.el)))();
      };
      const stopMirror = (b) => {
        if (!b.mirrored) return;
        b.mirrored = false;
        if (typeof videoMirror !== "undefined") guard(() => videoMirror.stop())();
      };
      const finishSeek = (b) => {
        b.seeking = false;
        b.time = b.seekTo;
        b.stamp = now();
        b.playing = false;
        fire(b.el, "seeked");
        fire(b.el, "timeupdate");
      };
      const progress = (b) => {
        if (bridgeOf.get(b.el) !== b) return;
        sendDuration(b);
        if (!b.metadata && b.states.length && b.states.every((st) => st.info)) {
          b.metadata = true;
          fire(b.el, "durationchange");
          fire(b.el, "loadedmetadata");
          fire(b.el, "resize");
        }
        if (b.seeking && holds(b, b.seekTo)) finishSeek(b);
        if (b.metadata && !b.loaded && holds(b, positionOf(b))) {
          b.loaded = true;
          for (const type of ["loadeddata", "canplay", "canplaythrough"]) fire(b.el, type);
        }
      };
      const stopTicking = (b) => {
        clearInterval(b.ticker);
        b.ticker = 0;
      };
      const tick = (b) => {
        if (bridgeOf.get(b.el) !== b || b.paused) return stopTicking(b);
        const position = positionOf(b);
        if (b.playing) {
          b.frames += Math.max(0, position - b.lastPosition) * FRAME_RATE;
          fire(b.el, "timeupdate");
        }
        b.lastPosition = position;
      };
      const startTicking = (b) => {
        if (!b.ticker) b.ticker = setInterval(guard(() => tick(b)), TICK_MS);
      };
      const reportRect = (b) => {
        const r = b.el.getBoundingClientRect();
        const visible = document.visibilityState === "visible" && b.el.isConnected && r.width > 0 && r.height > 0;
        const geometry = [r.left, r.top, r.width, r.height].join();
        if (geometry !== b.coverKey || ++b.coverAge >= 10) {
          b.cover = visible ? pinnedCover(b.el, r) : { top: 0, bottom: 0, radius: 0, backdrop: null };
          b.coverKey = geometry;
          b.coverAge = 0;
        }
        const rect = { op: "rect", media: b.id, x: r.left, y: r.top, width: r.width, height: r.height, scale: devicePixelRatio, visible, coverTop: b.cover.top, coverBottom: b.cover.bottom, radius: b.cover.radius, backdrop: b.cover.backdrop };
        const key = [rect.x, rect.y, rect.width, rect.height, rect.scale, visible, rect.coverTop, rect.coverBottom, rect.radius, rect.backdrop].join();
        if (key === b.rectKey) return;
        b.rectKey = key;
        sendMedia(b, rect);
      };
      const watchRect = (b) => {
        const step = guard(() => {
          if (bridgeOf.get(b.el) !== b) return;
          reportRect(b);
          apply(raf, window, [step]);
        });
        apply(raf, window, [step]);
      };
      const release = (el) => {
        const b = bridgeOf.get(el);
        if (!b) return;
        bridgeOf.delete(el);
        bridgeOfSource.delete(b.source);
        stopTicking(b);
        stopMirror(b);
        sendMedia(b, { op: "detach", media: b.id });
        if (held === b) held = null;
        if (bridged === b) {
          bridged = null;
          if (held) takeOver(held);
        }
      };
      const takeOver = (b) => {
        if (held === b) held = null;
        if (bridged && bridged !== b) release(bridged.el);
        b.held = false;
        bridged = b;
        for (const data of b.backlog.splice(0)) send("protectedVideo", data);
        if (typeof videoMirror !== "undefined") videoMirror.prepare();
      };
      const bridge = (el, source) => {
        const hold = !!(bridged && bridged.played && !bridged.ended && bridged.el !== el);
        if (held) release(held.el);
        if (bridged && !hold) release(bridged.el);
        const b = {
          id: ++mediaSeq,
          el,
          source,
          states: [],
          buffers: [],
          bufferSeq: 0,
          paused: true,
          ended: false,
          seeking: false,
          seekTo: 0,
          seekSeq: 0,
          time: 0,
          stamp: now(),
          playing: false,
          rate: el.playbackRate || 1,
          metadata: false,
          loaded: false,
          sourceEnded: false,
          frames: 0,
          dropped: 0,
          lastPosition: 0,
          error: null,
          size: [0, 0],
          rectKey: "",
          ticker: 0,
          mirrored: false,
          pip: false,
          pipWindow: null,
          pipEnter: [],
          pipExit: [],
          sentDuration: -1,
          initDuration: 0,
          played: false,
          held: hold,
          backlog: [],
        };
        bridgeOf.set(el, b);
        bridgeOfSource.set(source, b);
        if (hold) held = b;
        else bridged = b;
        sendMedia(b, { op: "attach", media: b.id });
        if (!hold && typeof videoMirror !== "undefined") videoMirror.prepare();
        sendMedia(b, { op: "volume", media: b.id, volume: el.volume, muted: el.muted });
        if (b.rate !== 1) sendMedia(b, { op: "rate", media: b.id, rate: b.rate });
        sendDuration(b);
        watchRect(b);
      };
      const ship = (b, st, kind, bytes, start, end) => {
        const seq = ++st.seq;
        const parts = Math.max(1, Math.ceil(bytes.length / PART_BYTES));
        for (let part = 0; part < parts; part++)
          sendMedia(b, {
            op: "append",
            media: b.id,
            buffer: st.id,
            kind,
            seq,
            part,
            parts,
            start,
            end,
            data: toBase64(bytes.subarray(part * PART_BYTES, (part + 1) * PART_BYTES)),
          });
      };
      const dropRange = (b, st, start, end) => {
        const kept = st.segments.filter((s) => {
          const middle = (s.start + s.end) / 2;
          return middle < start || middle >= end;
        });
        if (kept.length === st.segments.length) return;
        st.segments = kept;
        st.bytes = kept.reduce((sum, s) => sum + s.bytes, 0);
        sendMedia(b, { op: "remove", media: b.id, buffer: st.id, start, end: isFinite(end) ? end : 1e8 });
      };
      const makeRoom = (b, st, incoming) => {
        const quota = st.video ? VIDEO_QUOTA : AUDIO_QUOTA;
        if (st.bytes + incoming <= quota) return true;
        const before = positionOf(b) - KEEP_BEHIND_S;
        const old = st.segments.filter((s) => s.end < before).sort((x, y) => x.start - y.start);
        if (old.length) dropRange(b, st, -1e6, old[old.length - 1].end);
        return st.bytes + incoming <= quota;
      };
      const take = (b, st, unit) => {
        if (unit.kind === "init") {
          st.info = mp4.describeInit(unit.bytes);
          if (st.info.duration > 0 && !(b.initDuration > 0)) {
            b.initDuration = st.info.duration;
            if (Number.isNaN(b.source.duration)) {
              if (b.metadata) fire(b.el, "durationchange");
              sendDuration(b);
            }
          }
          if (st.video && st.info.width && st.info.height) {
            const changed = b.size[0] !== st.info.width || b.size[1] !== st.info.height;
            b.size = [st.info.width, st.info.height];
            if (changed && b.metadata) fire(b.el, "resize");
          }
          return ship(b, st, "init", unit.bytes, 0, 0);
        }
        if (!st.info) return;
        const times = mp4.fragmentTimes(unit.bytes, st.info);
        if (!times) return;
        const start = times[0] + st.offset;
        const end = Math.max(times[1] + st.offset, start + 0.001);
        if (end <= st.windowStart || start >= st.windowEnd) return;
        st.segments = st.segments.filter((s) => !(start < s.end - 0.05 && end > s.start + 0.05));
        st.segments.push({ start, end, bytes: unit.bytes.length });
        st.bytes = st.segments.reduce((sum, s) => sum + s.bytes, 0);
        ship(b, st, "segment", unit.bytes, start, end);
      };
      const sourceBufferList = (items) => {
        const out = new EventTarget();
        setPrototypeOf(out, SourceBufferList.prototype);
        defineProperty(out, "length", { value: items.length });
        items.forEach((item, i) => defineProperty(out, i, { value: item, enumerable: true }));
        defineProperty(out, Symbol.iterator, { value: () => items[Symbol.iterator]() });
        return out;
      };
      const makeBuffer = (b, mime) => {
        const sb = new EventTarget();
        setPrototypeOf(sb, SourceBuffer.prototype);
        const st = {
          id: ++b.bufferSeq,
          video: /^video\//i.test(mime),
          info: null,
          pending: new Uint8Array(0),
          segments: [],
          bytes: 0,
          updating: false,
          offset: 0,
          windowStart: 0,
          windowEnd: Infinity,
          mode: "segments",
          seq: 0,
          op: 0,
          removed: false,
        };
        const property = (name, descriptor) => defineProperty(sb, name, { configurable: true, enumerable: true, ...descriptor });
        const busy = () => new DOMException("This SourceBuffer is still processing an 'appendBuffer' or 'remove' operation.", "InvalidStateError");
        const gone = () => new DOMException("This SourceBuffer has been removed from the parent media source.", "InvalidStateError");
        const finish = () => {
          st.updating = false;
          fireOwn(sb, "update");
          fireOwn(sb, "updateend");
          progress(b);
        };
        property("updating", { get: () => st.updating });
        property("buffered", { get: () => timeRanges(mp4.merged(st.segments)) });
        property("timestampOffset", { get: () => st.offset, set: (v) => (st.offset = Number(v) || 0) });
        property("appendWindowStart", { get: () => st.windowStart, set: (v) => (st.windowStart = Number(v) || 0) });
        property("appendWindowEnd", { get: () => st.windowEnd, set: (v) => (st.windowEnd = Number(v)) });
        property("mode", { get: () => st.mode, set: (v) => (st.mode = String(v)) });
        for (const handler of ["onupdatestart", "onupdate", "onupdateend", "onerror", "onabort"]) property(handler, { value: null, writable: true });
        property("appendBuffer", {
          value: (data) => {
            if (st.removed) throw gone();
            if (st.updating) throw busy();
            const incoming = bytesOf(data);
            if (!makeRoom(b, st, incoming.length))
              throw new DOMException("The SourceBuffer is full, and cannot free space to append additional buffers.", "QuotaExceededError");
            const combined = new Uint8Array(st.pending.length + incoming.length);
            combined.set(st.pending);
            combined.set(incoming, st.pending.length);
            st.updating = true;
            const op = ++st.op;
            if (b.sourceEnded) {
              b.sourceEnded = false;
              sendMedia(b, { op: "end", media: b.id, ended: false });
              fire(b.source, "sourceopen");
            }
            soon(() => {
              if (st.op !== op || !st.updating) return;
              fireOwn(sb, "updatestart");
              const { units, rest } = mp4.split(combined);
              st.pending = combined.length - rest > MAX_PENDING_BYTES ? new Uint8Array(0) : combined.slice(rest);
              if (bridgeOf.get(b.el) === b) for (const unit of units) take(b, st, unit);
              finish();
            }, 0);
          },
        });
        property("remove", {
          value: (start, end) => {
            if (st.removed) throw gone();
            if (st.updating) throw busy();
            st.updating = true;
            const op = ++st.op;
            soon(() => {
              if (st.op !== op || !st.updating) return;
              fireOwn(sb, "updatestart");
              dropRange(b, st, Number(start), Number(end));
              finish();
            }, 0);
          },
        });
        property("abort", {
          value: () => {
            st.pending = new Uint8Array(0);
            st.op++;
            if (!st.updating) return;
            st.updating = false;
            fireOwn(sb, "abort");
            fireOwn(sb, "updateend");
          },
        });
        property("changeType", {
          value: (type) => {
            if (UNDECODABLE.test(String(type))) throw new DOMException("The type provided ('" + type + "') is unsupported.", "NotSupportedError");
            st.video = /^video\//i.test(String(type));
            sendMedia(b, { op: "buffer", media: b.id, buffer: st.id, mime: String(type).slice(0, 200) });
          },
        });
        b.states.push(st);
        b.buffers.push(sb);
        sendMedia(b, { op: "buffer", media: b.id, buffer: st.id, mime: mime.slice(0, 200) });
        return { sb, st };
      };

      const SourceProto = SourceType.prototype;
      SourceProto.addSourceBuffer = asNative(SourceProto.addSourceBuffer, (target, self, args) => {
        const type = String(args[0]);
        if (UNDECODABLE.test(type)) throw new DOMException("The type provided ('" + type + "') is unsupported.", "NotSupportedError");
        const b = bridgeOfSource.get(self);
        if (!b || b.states.length >= 8) return apply(target, self, args);
        if (b.bufferSeq >= MAX_BUFFER_ID) throw new DOMException("This MediaSource has reached the limit of SourceBuffer objects it can handle.", "QuotaExceededError");
        return makeBuffer(b, type).sb;
      });
      SourceProto.removeSourceBuffer = asNative(SourceProto.removeSourceBuffer, (target, self, args) => {
        const b = bridgeOfSource.get(self);
        const at = b ? b.buffers.indexOf(args[0]) : -1;
        if (at < 0) return apply(target, self, args);
        const st = b.states[at];
        st.removed = true;
        st.op++;
        st.updating = false;
        b.buffers.splice(at, 1);
        b.states.splice(at, 1);
        sendMedia(b, { op: "dropBuffer", media: b.id, buffer: st.id });
      });
      const sourceGetter = (name, read) => {
        const was = getOwnPropertyDescriptor(SourceProto, name);
        if (was && was.get)
          defineProperty(SourceProto, name, {
            ...was,
            get: asNative(was.get, (target, self, args) => {
              const b = bridgeOfSource.get(self);
              return b ? read(b, () => apply(target, self, args)) : apply(target, self, args);
            }),
          });
      };
      sourceGetter("sourceBuffers", (b) => sourceBufferList(b.buffers));
      sourceGetter("activeSourceBuffers", (b) => sourceBufferList(b.buffers));
      sourceGetter("readyState", (b, real) => (b.sourceEnded ? "ended" : real()));
      SourceProto.endOfStream = asNative(SourceProto.endOfStream, (target, self, args) => {
        const b = bridgeOfSource.get(self);
        if (!b) return apply(target, self, args);
        if (args[0]) return;
        b.sourceEnded = true;
        sendMedia(b, { op: "end", media: b.id, ended: true });
        sendDuration(b);
        fire(self, "sourceended");
      });
      const sourceDuration = getOwnPropertyDescriptor(SourceProto, "duration");
      if (sourceDuration && sourceDuration.set)
        defineProperty(SourceProto, "duration", {
          ...sourceDuration,
          set: asNative(sourceDuration.set, (target, self, args) => {
            const result = apply(target, self, args);
            const b = bridgeOfSource.get(self);
            if (b && bridgeOf.get(b.el) === b) sendDuration(b);
            return result;
          }),
        });
      const createObjectURL = URL.createObjectURL;
      URL.createObjectURL = asNative(createObjectURL, (target, self, args) => {
        const url = apply(target, self, args);
        if (args[0] instanceof SourceType) {
          sourceOfUrl.set(url, args[0]);
          if (sourceOfUrl.size > 32) sourceOfUrl.delete(sourceOfUrl.keys().next().value);
        }
        return url;
      });

      const getter = (proto, name, read) => {
        const was = getOwnPropertyDescriptor(proto, name);
        if (!was || !was.get) return;
        defineProperty(proto, name, {
          ...was,
          get: asNative(was.get, (target, self, args) => {
            const b = bridgeOf.get(self);
            return b ? read(b, self) : apply(target, self, args);
          }),
        });
      };
      const setter = (proto, name, write) => {
        const was = getOwnPropertyDescriptor(proto, name);
        if (!was || !was.set) return;
        defineProperty(proto, name, {
          ...was,
          set: asNative(was.set, (target, self, args) => {
            const b = bridgeOf.get(self);
            return b ? write(b, self, args[0], () => apply(target, self, args)) : apply(target, self, args);
          }),
        });
      };
      const method = (proto, name, call) => {
        const was = proto[name];
        if (typeof was !== "function") return;
        proto[name] = asNative(was, (target, self, args) => {
          const b = bridgeOf.get(self);
          return b ? call(b, self, args, () => apply(target, self, args)) : apply(target, self, args);
        });
      };
      const srcDescriptor = getOwnPropertyDescriptor(Media, "src");
      defineProperty(Media, "src", {
        ...srcDescriptor,
        set: asNative(srcDescriptor.set, (target, self, args) => {
          release(self);
          const result = apply(target, self, args);
          const source = sourceOfUrl.get(String(args[0]));
          if (source && self instanceof HTMLVideoElement && PLAYER_ROUTE.test(location.pathname)) bridge(self, source);
          return result;
        }),
      });
      method(Media, "load", (b, el, args, real) => {
        release(el);
        return real();
      });
      getter(Media, "currentTime", (b) => positionOf(b));
      setter(Media, "currentTime", (b, el, value) => {
        const time = Number(value);
        if (!isFinite(time)) throw new TypeError("Failed to set the 'currentTime' property on 'HTMLMediaElement': The provided double value is non-finite.");
        const duration = durationOf(b);
        const target = Math.max(0, isFinite(duration) ? Math.min(time, duration) : time);
        b.seekSeq++;
        b.ended = false;
        sendMedia(b, { op: "seek", media: b.id, time: target, seq: b.seekSeq });
        if (!b.metadata) {
          b.time = target;
          b.stamp = now();
          return;
        }
        b.seekTo = target;
        b.seeking = true;
        soon(() => {
          if (!b.seeking || b.seekTo !== target) return;
          fire(el, "seeking");
          progress(b);
        }, 0);
      });
      getter(Media, "paused", (b) => b.paused);
      getter(Media, "ended", (b) => b.ended);
      getter(Media, "seeking", (b) => b.seeking);
      getter(Media, "readyState", (b) => (b.metadata ? (holds(b, positionOf(b)) ? 4 : 1) : 0));
      getter(Media, "buffered", (b) => timeRanges(bufferedOf(b)));
      getter(Media, "seekable", (b) => (isFinite(durationOf(b)) ? timeRanges([[0, durationOf(b)]]) : timeRanges(bufferedOf(b))));
      getter(Media, "duration", (b) => durationOf(b));
      getter(Media, "error", (b) => b.error);
      getter(Video, "videoWidth", (b) => b.size[0]);
      getter(Video, "videoHeight", (b) => b.size[1]);
      getter(Video, "webkitDecodedFrameCount", (b) => Math.floor(b.frames));
      const droppedOf = (b) => Math.min(Math.floor(b.dropped), Math.floor(b.frames));
      getter(Video, "webkitDroppedFrameCount", droppedOf);
      getter(Media, "webkitVideoDecodedByteCount", (b) => Math.floor(b.frames) * 30000);
      getter(Media, "webkitAudioDecodedByteCount", (b) => Math.floor(b.frames) * 800);
      method(Video, "getVideoPlaybackQuality", (b) =>
        own(create(VideoPlaybackQuality.prototype), { creationTime: now(), totalVideoFrames: Math.floor(b.frames), droppedVideoFrames: droppedOf(b), corruptedVideoFrames: 0 })
      );
      const frameCallbacks = new Map();
      let frameCallbackSeq = 0;
      method(Video, "requestVideoFrameCallback", (b, el, args) => {
        const handle = ++frameCallbackSeq;
        const callback = args[0];
        const wait = () =>
          frameCallbacks.set(
            handle,
            apply(raf, window, [
              guard((at) => {
                if (!frameCallbacks.has(handle)) return;
                if (b.paused || !b.playing) return wait();
                frameCallbacks.delete(handle);
                callback(at, {
                  presentationTime: at,
                  expectedDisplayTime: at + 16,
                  width: b.size[0],
                  height: b.size[1],
                  mediaTime: positionOf(b),
                  presentedFrames: Math.floor(b.frames),
                  processingDuration: 0.005,
                });
              }),
            ])
          );
        wait();
        return handle;
      });
      method(Video, "cancelVideoFrameCallback", (b, el, args, real) => {
        if (!frameCallbacks.has(args[0])) return real();
        cancelAnimationFrame(frameCallbacks.get(args[0]));
        frameCallbacks.delete(args[0]);
      });
      const fireSoon = (b, el, types) =>
        soon(() => {
          if (bridgeOf.get(el) === b) for (const type of types) fire(el, type);
        }, 0);
      method(Media, "play", (b, el) => {
        if (b.error) return Promise.reject(new DOMException("The element has no supported sources.", "NotSupportedError"));
        b.played = true;
        if (b.held) takeOver(b);
        if (b.paused) {
          b.paused = false;
          b.stamp = now();
          b.lastPosition = positionOf(b);
          fireSoon(b, el, ["play"]);
          sendMedia(b, { op: "play", media: b.id });
        }
        startTicking(b);
        return Promise.resolve();
      });
      method(Media, "pause", (b, el) => {
        if (b.paused) return;
        b.time = positionOf(b);
        b.paused = true;
        b.playing = false;
        sendMedia(b, { op: "pause", media: b.id });
        fireSoon(b, el, ["timeupdate", "pause"]);
      });
      setter(Media, "volume", (b, el, value, real) => {
        real();
        sendMedia(b, { op: "volume", media: b.id, volume: el.volume, muted: el.muted });
      });
      setter(Media, "muted", (b, el, value, real) => {
        real();
        sendMedia(b, { op: "volume", media: b.id, volume: el.volume, muted: el.muted });
      });
      setter(Media, "playbackRate", (b, el, value, real) => {
        real();
        b.time = positionOf(b);
        b.stamp = now();
        b.rate = el.playbackRate || 1;
        sendMedia(b, { op: "rate", media: b.id, rate: b.rate });
      });
      const pictureInPictureWindow = (b) => {
        const out = new EventTarget();
        if (window.PictureInPictureWindow) setPrototypeOf(out, PictureInPictureWindow.prototype);
        return own(out, { width: b.size[0], height: b.size[1], onresize: null });
      };
      const pictureInPictureEvent = (type, pipWindow) => {
        try {
          return new PictureInPictureEvent(type, { bubbles: true, pictureInPictureWindow: pipWindow });
        } catch (e) {
          return own(new Event(type, { bubbles: true }), { pictureInPictureWindow: pipWindow });
        }
      };
      method(Video, "requestPictureInPicture", (b) => {
        if (b.pip) return Promise.resolve(b.pipWindow);
        return new Promise((resolve, reject) => {
          b.pipEnter.push({ resolve, reject });
          sendMedia(b, { op: "pip", media: b.id, enter: true });
        });
      });
      const documentPip = getOwnPropertyDescriptor(Document.prototype, "pictureInPictureElement");
      if (documentPip && documentPip.get)
        defineProperty(Document.prototype, "pictureInPictureElement", {
          ...documentPip,
          get: asNative(documentPip.get, (target, self, args) => {
            if (!bridged || !bridged.pip || self !== document) return apply(target, self, args);
            let el = bridged.el;
            while (el.getRootNode() !== document && el.getRootNode().host) el = el.getRootNode().host;
            return el;
          }),
        });
      const exitPip = Document.prototype.exitPictureInPicture;
      if (typeof exitPip === "function")
        Document.prototype.exitPictureInPicture = asNative(exitPip, (target, self, args) => {
          const b = bridged;
          if (!b || !b.pip || self !== document) return apply(target, self, args);
          return new Promise((resolve) => {
            b.pipExit.push(resolve);
            sendMedia(b, { op: "pip", media: b.id, enter: false });
          });
        });
      const pipChanged = (b, active) => {
        if (active && !b.pip) {
          b.pip = true;
          b.pipWindow = pictureInPictureWindow(b);
          for (const waiter of b.pipEnter.splice(0)) waiter.resolve(b.pipWindow);
          b.el.dispatchEvent(pictureInPictureEvent("enterpictureinpicture", b.pipWindow));
        } else if (!active) {
          for (const waiter of b.pipEnter.splice(0)) waiter.reject(new DOMException("Picture-in-Picture could not start.", "NotAllowedError"));
          for (const resolve of b.pipExit.splice(0)) resolve();
          if (b.pip) {
            b.pip = false;
            b.el.dispatchEvent(pictureInPictureEvent("leavepictureinpicture", b.pipWindow));
          }
        }
      };
      const mediaKeysDescriptor = getOwnPropertyDescriptor(Media, "mediaKeys");
      if (mediaKeysDescriptor && mediaKeysDescriptor.get)
        defineProperty(Media, "mediaKeys", {
          ...mediaKeysDescriptor,
          get: asNative(mediaKeysDescriptor.get, (target, self, args) => (keysOf.has(self) ? keysOf.get(self) : apply(target, self, args))),
        });
      if (typeof Media.setMediaKeys === "function")
        Media.setMediaKeys = asNative(Media.setMediaKeys, (target, self, args) => {
          const mediaKeys = args[0];
          if (mediaKeys && ownKeys.has(mediaKeys)) {
            keysOf.set(self, mediaKeys);
            return Promise.resolve();
          }
          keysOf.delete(self);
          return apply(target, self, args);
        });

      const onKeys = (m) => {
        const entry = keySessions.get(m.session);
        if (!entry) return;
        if (m.event === "message") {
          const message = fromBase64(String(m.data || "")).buffer;
          let event;
          try {
            event = new MediaKeyMessageEvent("message", { messageType: "license-request", message });
          } catch (e) {
            event = own(new Event("message"), { messageType: "license-request", message });
          }
          return fireOwn(entry.keySession, "message", event);
        }
        const waiting = entry.waiting.splice(0);
        if (m.ok !== true) {
          for (const waiter of waiting) waiter.reject(new DOMException("The key system rejected the licence.", "InvalidStateError"));
          return;
        }
        const statuses = new Map(entry.keySession.keyStatuses);
        for (const id of isArray(m.keyIDs) ? m.keyIDs : []) statuses.set(fromBase64(String(id)).buffer, "usable");
        entry.keySession.keyStatuses = statuses;
        for (const waiter of waiting) waiter.resolve();
        fireOwn(entry.keySession, "keystatuseschange");
      };
      handlers.protectedVideo = (m) => {
        if (m.event === "message" || m.event === "keys") return onKeys(m);
        const b = bridged;
        if (!b || m.media !== b.id) return;
        if (m.event === "time") {
          if (m.seq !== b.seekSeq || b.seeking || !isFinite(m.time)) return;
          b.time = m.time;
          b.stamp = now();
          if (isFinite(m.dropped) && m.dropped >= b.dropped) b.dropped = m.dropped;
          const playing = m.playing === true && !b.paused;
          if (playing && !b.playing) {
            b.playing = true;
            b.lastPosition = b.time;
            fire(b.el, "playing");
          } else if (!playing && b.playing) {
            b.playing = false;
            if (!b.paused) fire(b.el, "waiting");
          }
          if (b.playing) startMirror(b);
        } else if (m.event === "paused") {
          if (typeof m.paused === "boolean" && m.paused !== b.paused) askSiteToMatch(m.paused);
          if (m.paused === true && !b.paused) {
            b.time = positionOf(b);
            b.paused = true;
            b.playing = false;
            fire(b.el, "pause");
          } else if (m.paused === false && b.paused) {
            b.paused = false;
            b.stamp = now();
            fire(b.el, "play");
            startTicking(b);
          }
        } else if (m.event === "ended") {
          const duration = durationOf(b);
          b.time = isFinite(duration) ? duration : positionOf(b);
          b.playing = false;
          b.ended = true;
          fire(b.el, "timeupdate");
          if (!b.paused) {
            b.paused = true;
            fire(b.el, "pause");
          }
          fire(b.el, "ended");
        } else if (m.event === "pip") {
          pipChanged(b, m.active === true);
        } else if (m.event === "seekBy") {
          if (typeof m.delta === "number" && isFinite(m.delta) && b.metadata) b.el.currentTime = positionOf(b) + m.delta;
        } else if (m.event === "failed") {
          b.error = own(create(MediaError.prototype), { code: 3, message: "Protected playback failed" });
          b.paused = true;
          b.playing = false;
          stopTicking(b);
          fire(b.el, "error");
        }
      };
      addEventListener(
        "visibilitychange",
        guard(() => {
          if (bridged) reportRect(bridged);
        })
      );
      addEventListener(
        "pagehide",
        guard((e) => {
          if (e.isTrusted && bridged) release(bridged.el);
        })
      );
    }
  } catch (e) {}
  const HLS_VIDEO_ORIGINS = ["https://www.youtube.com"];
  try {
    if (PROTECTED_VIDEO_ON && HLS_VIDEO_ORIGINS.includes(location.origin)) {
      const SAFARI_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15";
      const { defineProperty, getOwnPropertyDescriptor, create } = Object;
      const face = { userAgent: SAFARI_UA, appVersion: SAFARI_UA.slice(8), vendor: "Apple Computer, Inc.", platform: "MacIntel", userAgentData: undefined };
      for (const name of keys(face)) {
        const was = getOwnPropertyDescriptor(Navigator.prototype, name);
        if (was && was.get) defineProperty(Navigator.prototype, name, { ...was, get: asNative(was.get, () => face[name]) });
      }
      try {
        delete window.chrome;
      } catch (e) {}
      if (isTop) {
        bridgesProtectedPlayback = () => true;
        const FAIRPLAY = /^com\.apple\.fps/;
        const UNDECODABLE = /vp0?[89]|av01|dav1|opus|vorbis/i;
        const PLAYLIST_URL = /^data:application\/(?:vnd\.apple\.mpegurl|x-mpegurl)((?:;[^,]*)?),/i;
        const HLS_TYPE = /^\s*(?:application\/(?:vnd\.apple\.mpegurl|x-mpegurl)|audio\/(?:x-)?mpegurl)\s*(?:;|$)/i;
        const KEYED_PLAYLIST = /URI="skd:\/\//i;
        const PART_CHARS = 30000;
        const MAX_PARTS = 40;
        const MAX_KEY_BYTES = 45000;
        const TICK_MS = 250;
        const FRAME_RATE = 24;
        const AHEAD_LIMIT_S = 1;
        const READY_GIVE_UP_MS = 45000;
        const SEEK_GIVE_UP_MS = 10000;
        const Media = HTMLMediaElement.prototype;
        const Video = HTMLVideoElement.prototype;
        const ElementProto = Element.prototype;
        const fromCharCode = String.fromCharCode;
        const { btoa, atob } = window;
        const clock = performance;
        const clockNow = clock.now;
        const now = () => apply(clockNow, clock, []);
        const soon = (fn, ms) => setTimeout(guard(fn), ms);
        const bytesOf = (b) =>
          b instanceof ArrayBuffer ? new Uint8Array(b) : ArrayBuffer.isView(b) ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : new Uint8Array(0);
        const toBase64 = (bytes) => {
          let text = "";
          for (let i = 0; i < bytes.length; i += 0x8000) text += apply(fromCharCode, null, bytes.subarray(i, i + 0x8000));
          return btoa(text);
        };
        const fromBase64 = (text) => {
          const binary = atob(String(text || ""));
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          return bytes;
        };
        const fire = (target, type) => target.dispatchEvent(new Event(type));
        const own = (target, values) => {
          for (const name of keys(values)) defineProperty(target, name, { value: values[name], writable: true, configurable: true, enumerable: true });
          return target;
        };
        const fireOwn = (target, type, values) => {
          const event = own(new Event(type), values || {});
          target.dispatchEvent(event);
          const handler = target["on" + type];
          if (typeof handler === "function") apply(handler, target, [event]);
        };
        const timeRanges = (list) => {
          const out = create(TimeRanges.prototype);
          const at = (i) => {
            if (!(i >= 0 && i < list.length)) throw new DOMException("The index provided is out of range.", "IndexSizeError");
            return list[i];
          };
          defineProperty(out, "length", { value: list.length });
          defineProperty(out, "start", { value: (i) => at(i)[0] });
          defineProperty(out, "end", { value: (i) => at(i)[1] });
          return out;
        };
        const playlistOf = (value) => {
          const url = String(value);
          const head = url.match(PLAYLIST_URL);
          if (!head) return null;
          try {
            const playlist = /;base64/i.test(head[1]) ? atob(url.slice(head[0].length)) : decodeURIComponent(url.slice(head[0].length));
            return /^#EXTM3U/.test(playlist) ? playlist : null;
          } catch (e) {
            return null;
          }
        };

        const keySessions = new Map();
        const keysOf = new WeakMap();
        let keySessionSeq = 0;
        const makeKeySession = (keySystem, data) => {
          const id = ++keySessionSeq;
          const keySession = new EventTarget();
          own(keySession, {
            keySystem,
            sessionId: "ardia-" + id,
            error: null,
            onwebkitkeymessage: null,
            onwebkitkeyadded: null,
            onwebkitkeyerror: null,
            update: (key) => {
              const bytes = bytesOf(key);
              if (!bytes.length || bytes.length > MAX_KEY_BYTES) throw new DOMException("The key is not valid.", "InvalidAccessError");
              if (keySessions.has(id)) send("hlsVideo", { op: "update", session: id, data: toBase64(bytes) });
            },
            close: () => {
              if (keySessions.delete(id)) send("hlsVideo", { op: "closeSession", session: id });
            },
          });
          keySessions.set(id, keySession);
          send("hlsVideo", { op: "session", session: id, data: toBase64(data) });
          return keySession;
        };
        const WebKitMediaKeys = function WebKitMediaKeys(keySystem) {
          if (!new.target) throw new TypeError("Failed to construct 'WebKitMediaKeys': Please use the 'new' operator.");
          const system = String(keySystem);
          if (!FAIRPLAY.test(system)) throw new DOMException("The key system is not supported.", "NotSupportedError");
          defineProperty(this, "keySystem", { value: system, enumerable: true });
        };
        defineProperty(WebKitMediaKeys, "isTypeSupported", {
          value: (keySystem, type) => FAIRPLAY.test(String(keySystem)) && !UNDECODABLE.test(String(type || "")),
          writable: true,
          configurable: true,
        });
        defineProperty(WebKitMediaKeys.prototype, "createSession", {
          value: function createSession(type, initData) {
            const data = bytesOf(initData);
            if (!data.length || data.length > MAX_KEY_BYTES) throw new DOMException("The init data is not valid.", "InvalidAccessError");
            return makeKeySession(this.keySystem, data);
          },
          writable: true,
          configurable: true,
        });
        defineProperty(window, "WebKitMediaKeys", { value: WebKitMediaKeys, writable: true, configurable: true });

        const canPlayType = Media.canPlayType;
        Media.canPlayType = asNative(canPlayType, (target, self, args) => (HLS_TYPE.test(String(args[0])) ? "maybe" : apply(target, self, args)));

        const bridgeOf = new WeakMap();
        const heldPlaylists = new WeakMap();
        let bridged = null;
        let mediaSeq = 0;
        const removeAttributeNative = ElementProto.removeAttribute;
        const loadNative = Media.load;
        const positionOf = (b) => {
          if (b.seeking) return b.seekTo;
          if (b.paused || !b.playing) return b.time;
          const limit = isFinite(b.duration) ? b.duration : Infinity;
          return Math.min(b.time + ((now() - b.stamp) / 1000) * b.rate, b.time + AHEAD_LIMIT_S, limit);
        };
        const startMirror = (b) => {
          if (typeof videoMirror === "undefined") return;
          const again = b.mirrored;
          b.mirrored = true;
          guard(() => (again ? videoMirror.ensure(b.el) : videoMirror.start(b.el)))();
        };
        const stopMirror = (b) => {
          if (!b.mirrored) return;
          b.mirrored = false;
          if (typeof videoMirror !== "undefined") guard(() => videoMirror.stop())();
        };
        const stopTicking = (b) => {
          clearInterval(b.ticker);
          b.ticker = 0;
        };
        const tick = (b) => {
          if (bridgeOf.get(b.el) !== b || b.paused) return stopTicking(b);
          const position = positionOf(b);
          if (b.playing) {
            b.frames += Math.max(0, position - b.lastPosition) * FRAME_RATE;
            fire(b.el, "timeupdate");
          }
          b.lastPosition = position;
        };
        const startTicking = (b) => {
          if (!b.ticker) b.ticker = setInterval(guard(() => tick(b)), TICK_MS);
        };
        const fireSoon = (b, types) =>
          soon(() => {
            if (bridgeOf.get(b.el) === b) for (const type of types) fire(b.el, type);
          }, 0);
        const reportRect = (b) => {
          const r = b.el.getBoundingClientRect();
          const visible = document.visibilityState === "visible" && b.el.isConnected && r.width > 0 && r.height > 0;
          const geometry = [r.left, r.top, r.width, r.height].join();
          if (geometry !== b.coverKey || ++b.coverAge >= 10) {
            b.cover = visible ? pinnedCover(b.el, r) : { top: 0, bottom: 0, radius: 0, backdrop: null };
            b.coverKey = geometry;
            b.coverAge = 0;
          }
          const rect = { op: "rect", media: b.id, x: r.left, y: r.top, width: r.width, height: r.height, scale: devicePixelRatio, visible, coverTop: b.cover.top, coverBottom: b.cover.bottom, radius: b.cover.radius, backdrop: b.cover.backdrop };
          const key = [rect.x, rect.y, rect.width, rect.height, rect.scale, visible, rect.coverTop, rect.coverBottom, rect.radius, rect.backdrop].join();
          if (key === b.rectKey) return;
          b.rectKey = key;
          send("hlsVideo", rect);
        };
        const watchRect = (b) => {
          const step = guard(() => {
            if (bridgeOf.get(b.el) !== b) return;
            reportRect(b);
            apply(raf, window, [step]);
          });
          apply(raf, window, [step]);
        };
        const pictureInPictureWindow = (b) => {
          const out = new EventTarget();
          if (window.PictureInPictureWindow) setPrototypeOf(out, PictureInPictureWindow.prototype);
          return own(out, { width: b.size[0], height: b.size[1], onresize: null });
        };
        const pictureInPictureEvent = (type, pipWindow) => {
          try {
            return new PictureInPictureEvent(type, { bubbles: true, pictureInPictureWindow: pipWindow });
          } catch (e) {
            return own(new Event(type, { bubbles: true }), { pictureInPictureWindow: pipWindow });
          }
        };
        const pipChanged = (b, active) => {
          if (active && !b.pip) {
            b.pip = true;
            b.pipWindow = pictureInPictureWindow(b);
            for (const waiter of b.pipEnter.splice(0)) waiter.resolve(b.pipWindow);
            b.el.dispatchEvent(pictureInPictureEvent("enterpictureinpicture", b.pipWindow));
          } else if (!active) {
            for (const waiter of b.pipEnter.splice(0)) waiter.reject(new DOMException("Picture-in-Picture could not start.", "NotAllowedError"));
            for (const resolve of b.pipExit.splice(0)) resolve();
            if (b.pip) {
              b.pip = false;
              b.el.dispatchEvent(pictureInPictureEvent("leavepictureinpicture", b.pipWindow));
            }
          }
        };
        const release = (el) => {
          const b = bridgeOf.get(el);
          if (!b) return;
          bridgeOf.delete(el);
          stopTicking(b);
          stopMirror(b);
          pipChanged(b, false);
          if (bridged === b) bridged = null;
          send("hlsVideo", { op: "detach", media: b.id });
        };
        const fail = (b) => {
          if (b.error) return;
          b.error = own(create(MediaError.prototype), { code: 3, message: "Protected playback failed" });
          b.paused = true;
          b.playing = false;
          stopTicking(b);
          fire(b.el, "error");
          send("hlsVideo", { op: "failed", media: b.id });
        };
        const bridge = (el, url, playlist) => {
          if (bridged && bridged.el !== el) release(bridged.el);
          release(el);
          heldPlaylists.delete(el);
          apply(removeAttributeNative, el, ["src"]);
          apply(loadNative, el, []);
          const b = {
            id: ++mediaSeq,
            el,
            url,
            paused: true,
            ended: false,
            seeking: false,
            seekTo: 0,
            seekSeq: 0,
            time: 0,
            stamp: now(),
            playing: false,
            rate: el.playbackRate || 1,
            ready: false,
            waiting: false,
            duration: NaN,
            buffered: [],
            seekableRange: null,
            size: [0, 0],
            error: null,
            frames: 0,
            lastPosition: 0,
            rectKey: "",
            ticker: 0,
            mirrored: false,
            pip: false,
            pipWindow: null,
            pipEnter: [],
            pipExit: [],
          };
          bridgeOf.set(el, b);
          bridged = b;
          if (typeof videoMirror !== "undefined") videoMirror.prepare();
          const parts = Math.max(1, Math.ceil(playlist.length / PART_CHARS));
          for (let part = 0; part < parts; part++)
            send("hlsVideo", {
              op: "load",
              media: b.id,
              part,
              parts,
              playlist: playlist.slice(part * PART_CHARS, (part + 1) * PART_CHARS),
              volume: el.volume,
              muted: el.muted,
              rate: b.rate,
            });
          fireSoon(b, ["loadstart"]);
          watchRect(b);
          soon(() => {
            if (bridgeOf.get(el) === b && !b.ready) fail(b);
          }, READY_GIVE_UP_MS);
        };
        const takeSrc = (el, value) => {
          const url = String(value);
          const playlist = playlistOf(url);
          if (playlist === null || !(el instanceof HTMLVideoElement) || playlist.length > PART_CHARS * MAX_PARTS) {
            heldPlaylists.delete(el);
            return false;
          }
          if (!keysOf.has(el) && !KEYED_PLAYLIST.test(playlist)) {
            heldPlaylists.set(el, url);
            return false;
          }
          bridge(el, url, playlist);
          return true;
        };
        defineProperty(Media, "webkitSetMediaKeys", {
          value: function webkitSetMediaKeys(mediaKeys) {
            if (mediaKeys && !(mediaKeys instanceof WebKitMediaKeys))
              throw new TypeError("Failed to execute 'webkitSetMediaKeys' on 'HTMLMediaElement': parameter 1 is not of type 'WebKitMediaKeys'.");
            if (!mediaKeys) return void keysOf.delete(this);
            keysOf.set(this, mediaKeys);
            const held = heldPlaylists.get(this);
            if (held && !bridgeOf.has(this)) guard(takeSrc)(this, held);
          },
          writable: true,
          configurable: true,
        });
        defineProperty(Media, "webkitKeys", { get: asNative(function webkitKeys() {}, (target, self) => keysOf.get(self) || null), configurable: true });

        const getter = (proto, name, read) => {
          const was = getOwnPropertyDescriptor(proto, name);
          if (!was || !was.get) return;
          defineProperty(proto, name, {
            ...was,
            get: asNative(was.get, (target, self, args) => {
              const b = bridgeOf.get(self);
              return b ? read(b, self) : apply(target, self, args);
            }),
          });
        };
        const setter = (proto, name, write) => {
          const was = getOwnPropertyDescriptor(proto, name);
          if (!was || !was.set) return;
          defineProperty(proto, name, {
            ...was,
            set: asNative(was.set, (target, self, args) => {
              const b = bridgeOf.get(self);
              return b ? write(b, self, args[0], () => apply(target, self, args)) : apply(target, self, args);
            }),
          });
        };
        const method = (proto, name, call) => {
          const was = proto[name];
          if (typeof was !== "function") return;
          proto[name] = asNative(was, (target, self, args) => {
            const b = bridgeOf.get(self);
            return b ? call(b, self, args, () => apply(target, self, args)) : apply(target, self, args);
          });
        };
        const srcDescriptor = getOwnPropertyDescriptor(Media, "src");
        defineProperty(Media, "src", {
          ...srcDescriptor,
          get: asNative(srcDescriptor.get, (target, self, args) => {
            const b = bridgeOf.get(self);
            return b ? b.url : apply(target, self, args);
          }),
          set: asNative(srcDescriptor.set, (target, self, args) => {
            if (guard(takeSrc)(self, args[0])) return;
            guard(release)(self);
            return apply(target, self, args);
          }),
        });
        const srcObject = getOwnPropertyDescriptor(Media, "srcObject");
        if (srcObject && srcObject.set)
          defineProperty(Media, "srcObject", {
            ...srcObject,
            set: asNative(srcObject.set, (target, self, args) => {
              guard(release)(self);
              heldPlaylists.delete(self);
              return apply(target, self, args);
            }),
          });
        const isSrc = (name) => typeof name === "string" && name.toLowerCase() === "src";
        defineProperty(Media, "setAttribute", {
          ...getOwnPropertyDescriptor(ElementProto, "setAttribute"),
          value: asNative(ElementProto.setAttribute, (target, self, args) => {
            if (isSrc(args[0])) {
              if (guard(takeSrc)(self, args[1])) return;
              guard(release)(self);
            }
            return apply(target, self, args);
          }),
        });
        defineProperty(Media, "removeAttribute", {
          ...getOwnPropertyDescriptor(ElementProto, "removeAttribute"),
          value: asNative(removeAttributeNative, (target, self, args) => {
            if (isSrc(args[0])) {
              guard(release)(self);
              heldPlaylists.delete(self);
            }
            return apply(target, self, args);
          }),
        });
        method(Media, "load", (b, el, args, real) => {
          release(el);
          return real();
        });
        getter(Media, "currentSrc", (b) => b.url);
        getter(Media, "currentTime", (b) => positionOf(b));
        setter(Media, "currentTime", (b, el, value) => {
          const time = Number(value);
          if (!isFinite(time)) throw new TypeError("Failed to set the 'currentTime' property on 'HTMLMediaElement': The provided double value is non-finite.");
          const target = Math.max(0, isFinite(b.duration) ? Math.min(time, b.duration) : time);
          const seq = ++b.seekSeq;
          b.ended = false;
          send("hlsVideo", { op: "seek", media: b.id, time: target, seq });
          if (!b.ready) {
            b.time = target;
            b.stamp = now();
            return;
          }
          b.seekTo = target;
          b.seeking = true;
          b.playing = false;
          fireSoon(b, ["seeking"]);
          soon(() => {
            if (bridgeOf.get(el) !== b || !b.seeking || b.seekSeq !== seq) return;
            b.seeking = false;
            b.time = target;
            b.stamp = now();
            fire(el, "seeked");
            fire(el, "timeupdate");
          }, SEEK_GIVE_UP_MS);
        });
        getter(Media, "paused", (b) => b.paused);
        getter(Media, "ended", (b) => b.ended);
        getter(Media, "seeking", (b) => b.seeking);
        getter(Media, "readyState", (b) => (!b.ready ? 0 : b.seeking || b.waiting ? 2 : 4));
        getter(Media, "networkState", (b) => (b.ready ? 1 : 2));
        getter(Media, "buffered", (b) => timeRanges(b.buffered));
        getter(Media, "seekable", (b) => timeRanges(b.seekableRange ? [b.seekableRange] : isFinite(b.duration) ? [[0, b.duration]] : []));
        getter(Media, "played", (b) => timeRanges(b.ready ? [[0, positionOf(b)]] : []));
        getter(Media, "duration", (b) => b.duration);
        getter(Media, "error", (b) => b.error);
        getter(Video, "videoWidth", (b) => b.size[0]);
        getter(Video, "videoHeight", (b) => b.size[1]);
        getter(Video, "webkitDecodedFrameCount", (b) => Math.floor(b.frames));
        getter(Video, "webkitDroppedFrameCount", () => 0);
        getter(Media, "webkitVideoDecodedByteCount", (b) => Math.floor(b.frames) * 30000);
        getter(Media, "webkitAudioDecodedByteCount", (b) => Math.floor(b.frames) * 800);
        method(Video, "getVideoPlaybackQuality", (b) =>
          own(create(VideoPlaybackQuality.prototype), { creationTime: now(), totalVideoFrames: Math.floor(b.frames), droppedVideoFrames: 0, corruptedVideoFrames: 0 })
        );
        const frameCallbacks = new Map();
        let frameCallbackSeq = 0;
        method(Video, "requestVideoFrameCallback", (b, el, args) => {
          const handle = ++frameCallbackSeq;
          const callback = args[0];
          const wait = () =>
            frameCallbacks.set(
              handle,
              apply(raf, window, [
                guard((at) => {
                  if (!frameCallbacks.has(handle)) return;
                  if (b.paused || !b.playing) return wait();
                  frameCallbacks.delete(handle);
                  callback(at, {
                    presentationTime: at,
                    expectedDisplayTime: at + 16,
                    width: b.size[0],
                    height: b.size[1],
                    mediaTime: positionOf(b),
                    presentedFrames: Math.floor(b.frames),
                    processingDuration: 0.005,
                  });
                }),
              ])
            );
          wait();
          return handle;
        });
        method(Video, "cancelVideoFrameCallback", (b, el, args, real) => {
          if (!frameCallbacks.has(args[0])) return real();
          cancelAnimationFrame(frameCallbacks.get(args[0]));
          frameCallbacks.delete(args[0]);
        });
        method(Media, "play", (b, el) => {
          if (b.error) return Promise.reject(new DOMException("The element has no supported sources.", "NotSupportedError"));
          if (b.paused && blockAutoplay && !askedToPlay()) return Promise.reject(autoplayRefusal());
          if (b.paused) {
            if (b.ended) {
              b.ended = false;
              b.time = 0;
              b.seekSeq++;
              send("hlsVideo", { op: "seek", media: b.id, time: 0, seq: b.seekSeq });
            }
            b.paused = false;
            b.stamp = now();
            b.lastPosition = positionOf(b);
            fireSoon(b, ["play"]);
            send("hlsVideo", { op: "play", media: b.id });
          }
          startTicking(b);
          return Promise.resolve();
        });
        method(Media, "pause", (b) => {
          if (b.paused) return;
          b.time = positionOf(b);
          b.stamp = now();
          b.paused = true;
          b.playing = false;
          send("hlsVideo", { op: "pause", media: b.id });
          fireSoon(b, ["timeupdate", "pause"]);
        });
        setter(Media, "volume", (b, el, value, real) => {
          real();
          send("hlsVideo", { op: "volume", media: b.id, volume: el.volume, muted: el.muted });
        });
        setter(Media, "muted", (b, el, value, real) => {
          real();
          send("hlsVideo", { op: "volume", media: b.id, volume: el.volume, muted: el.muted });
        });
        setter(Media, "playbackRate", (b, el, value, real) => {
          real();
          b.time = positionOf(b);
          b.stamp = now();
          b.rate = el.playbackRate || 1;
          send("hlsVideo", { op: "rate", media: b.id, rate: b.rate });
        });
        method(Video, "requestPictureInPicture", (b) => {
          if (b.pip) return Promise.resolve(b.pipWindow);
          return new Promise((resolve, reject) => {
            b.pipEnter.push({ resolve, reject });
            send("hlsVideo", { op: "pip", media: b.id, enter: true });
          });
        });
        const documentPip = getOwnPropertyDescriptor(Document.prototype, "pictureInPictureElement");
        if (documentPip && documentPip.get)
          defineProperty(Document.prototype, "pictureInPictureElement", {
            ...documentPip,
            get: asNative(documentPip.get, (target, self, args) => {
              if (!bridged || !bridged.pip || self !== document) return apply(target, self, args);
              let el = bridged.el;
              while (el.getRootNode() !== document && el.getRootNode().host) el = el.getRootNode().host;
              return el;
            }),
          });
        const exitPip = Document.prototype.exitPictureInPicture;
        if (typeof exitPip === "function")
          Document.prototype.exitPictureInPicture = asNative(exitPip, (target, self, args) => {
            const b = bridged;
            if (!b || !b.pip || self !== document) return apply(target, self, args);
            return new Promise((resolve) => {
              b.pipExit.push(resolve);
              send("hlsVideo", { op: "pip", media: b.id, enter: false });
            });
          });

        const onKeys = (m) => {
          const keySession = keySessions.get(m.session);
          if (!keySession) return;
          if (m.event === "keymessage") return fireOwn(keySession, "webkitkeymessage", { message: fromBase64(m.data), destinationURL: "" });
          if (m.event === "keyadded") return fireOwn(keySession, "webkitkeyadded");
          keySession.error = { code: 1, systemCode: typeof m.code === "number" && isFinite(m.code) ? m.code : 0 };
          fireOwn(keySession, "webkitkeyerror");
        };
        const sameSize = (b, size) => isArray(size) && size[0] === b.size[0] && size[1] === b.size[1];
        const noteTime = (b, m) => {
          if (isArray(m.buffered)) b.buffered = m.buffered.filter((r) => isArray(r) && isFinite(r[0]) && isFinite(r[1]) && r[1] >= r[0]).slice(0, 16);
          b.seekableRange = isArray(m.seekable) && isFinite(m.seekable[0]) && isFinite(m.seekable[1]) ? [m.seekable[0], m.seekable[1]] : null;
          const duration = m.duration === "live" ? Infinity : typeof m.duration === "number" && m.duration > 0 ? m.duration : NaN;
          if (!(duration === b.duration || (Number.isNaN(duration) && Number.isNaN(b.duration)))) {
            b.duration = duration;
            if (b.ready) fire(b.el, "durationchange");
          }
          if (isArray(m.size) && m.size[0] > 0 && m.size[1] > 0 && !sameSize(b, m.size)) {
            b.size = [m.size[0], m.size[1]];
            if (b.ready) fire(b.el, "resize");
          }
        };
        handlers.hlsVideo = (m) => {
          if (!m) return;
          if (m.event === "keymessage" || m.event === "keyadded" || m.event === "keyerror") return onKeys(m);
          const b = bridged;
          if (!b || m.media !== b.id) return;
          if (m.event === "needkey") {
            const initData = fromBase64(m.data);
            if (initData.length) fireOwn(b.el, "webkitneedkey", { initData });
          } else if (m.event === "ready") {
            noteTime(b, m);
            if (b.ready) return;
            b.ready = true;
            for (const type of ["durationchange", "loadedmetadata", "loadeddata", "canplay", "canplaythrough"]) fire(b.el, type);
            if (b.size[0]) fire(b.el, "resize");
          } else if (m.event === "time") {
            noteTime(b, m);
            if (m.seq !== b.seekSeq || b.seeking || !isFinite(m.time)) return;
            b.time = m.time;
            b.stamp = now();
            const playing = m.playing === true && !b.paused;
            const waiting = m.waiting === true && !b.paused;
            if (playing && !b.playing) {
              b.playing = true;
              b.waiting = false;
              b.lastPosition = b.time;
              fire(b.el, "playing");
            } else if (!playing && b.playing) {
              b.playing = false;
              if (!b.paused) {
                b.waiting = true;
                fire(b.el, "waiting");
              }
            } else if (waiting !== b.waiting) {
              b.waiting = waiting;
              if (waiting) fire(b.el, "waiting");
            }
            if (b.playing) startMirror(b);
          } else if (m.event === "seeked") {
            if (m.seq !== b.seekSeq || !isFinite(m.time)) return;
            b.time = m.time;
            b.stamp = now();
            if (!b.seeking) return;
            b.seeking = false;
            fire(b.el, "seeked");
            fire(b.el, "timeupdate");
          } else if (m.event === "jumped") {
            if (b.seeking || !isFinite(m.time)) return;
            b.time = m.time;
            b.stamp = now();
            b.ended = false;
            fire(b.el, "seeking");
            fire(b.el, "seeked");
            fire(b.el, "timeupdate");
          } else if (m.event === "paused") {
            if (typeof m.paused === "boolean" && m.paused !== b.paused) askSiteToMatch(m.paused);
            if (m.paused === true && !b.paused) {
              b.time = positionOf(b);
              b.stamp = now();
              b.paused = true;
              b.playing = false;
              fire(b.el, "pause");
            } else if (m.paused === false && b.paused) {
              b.paused = false;
              b.stamp = now();
              fire(b.el, "play");
              startTicking(b);
            }
          } else if (m.event === "ended") {
            b.time = isFinite(b.duration) ? b.duration : positionOf(b);
            b.stamp = now();
            b.playing = false;
            b.ended = true;
            fire(b.el, "timeupdate");
            if (!b.paused) {
              b.paused = true;
              fire(b.el, "pause");
            }
            stopTicking(b);
            fire(b.el, "ended");
          } else if (m.event === "pip") {
            pipChanged(b, m.active === true);
          } else if (m.event === "failed") {
            fail(b);
          }
        };
        addEventListener(
          "visibilitychange",
          guard(() => {
            if (bridged) reportRect(bridged);
          })
        );
        addEventListener(
          "pagehide",
          guard((e) => {
            if (e.isTrusted && bridged) release(bridged.el);
          })
        );
      }
    }
  } catch (e) {}
  try {
    const NavigatorType = window.Navigator;
    const requestAccess = NavigatorType && NavigatorType.prototype.requestMediaKeySystemAccess;
    if (typeof requestAccess === "function") {
      const protectedSystem = /^com\.(widevine\.alpha|microsoft\.playready|apple\.fps)/;
      const { test } = RegExp.prototype;
      const then = Promise.prototype.then;
      const GRACE_MS = 5000;
      const KEYS_GRACE_MS = 2000;
      const MEDIA_ERR_DECODE = 3;
      let drmSent = false;
      let refused = "";
      const attempted = new Set();
      const grantedOnActivation = new WeakSet();
      const needsProtectedPlayback = (keySystem) => {
        if (drmSent || bridgesProtectedPlayback()) return;
        drmSent = true;
        send("drm", { keySystem });
      };
      reportProtectedPlayback = needsProtectedPlayback;
      const progressed = (m) => m.readyState >= 2 && m.currentTime > 0;
      const anyProgressed = () => [...attempted, ...document.querySelectorAll("video, audio")].some(progressed);
      const after = (ms, fn) => setTimeout(guard(fn), ms);
      const stalled = (m) => !m.paused && !m.ended && !progressed(m);
      const judgeAttempt = (m) =>
        after(GRACE_MS, () => {
          if (refused && stalled(m)) needsProtectedPlayback(refused);
        });
      const onAttempt = (m) => {
        if (attempted.size >= 16) attempted.delete(attempted.values().next().value);
        attempted.add(m);
        judgeAttempt(m);
      };
      const onNeedsKey = (m) =>
        after(KEYS_GRACE_MS, () => {
          if (!m.mediaKeys && !progressed(m)) needsProtectedPlayback(refused);
        });
      const onDrmMediaEvent = (e) => {
        const m = e.target;
        if (drmSent || !(m instanceof HTMLMediaElement)) return;
        if (e.type === "play") onAttempt(m);
        else if (e.type === "encrypted" || e.type === "waitingforkey") onNeedsKey(m);
        else if (e.type === "error" && refused && m.error && m.error.code === MEDIA_ERR_DECODE) needsProtectedPlayback(refused);
      };
      const drmMediaEvents = ["play", "encrypted", "waitingforkey", "error"];
      for (const type of drmMediaEvents) document.addEventListener(type, guard(onDrmMediaEvent), true);
      detachedMediaWatchers.push((m) => {
        for (const type of drmMediaEvents) m.addEventListener(type, guard(onDrmMediaEvent));
      });
      const onRefused = (keySystem, activated) => {
        if (drmSent) return;
        if (!refused) refused = keySystem;
        for (const m of attempted) if (stalled(m)) judgeAttempt(m);
        if (activated)
          after(GRACE_MS, () => {
            if (!anyProgressed()) needsProtectedPlayback(keySystem);
          });
      };
      const wrapped = asNative(requestAccess, (target, self, args) => {
        const result = apply(target, self, args);
        const keySystem = args[0];
        if (!drmSent && typeof keySystem === "string" && apply(test, protectedSystem, [keySystem])) {
          const activated = !!(navigator.userActivation && navigator.userActivation.isActive);
          const remember = guard((access) => activated && access && typeof access === "object" && grantedOnActivation.add(access));
          apply(then, result, [remember, () => onRefused(keySystem, activated)]);
        }
        return result;
      });
      Object.defineProperty(NavigatorType.prototype, "requestMediaKeySystemAccess", {
        ...Object.getOwnPropertyDescriptor(NavigatorType.prototype, "requestMediaKeySystemAccess"),
        value: wrapped,
      });
      const AccessType = window.MediaKeySystemAccess;
      const createKeys = AccessType && AccessType.prototype.createMediaKeys;
      const keySystemOf = AccessType && Object.getOwnPropertyDescriptor(AccessType.prototype, "keySystem");
      if (typeof createKeys === "function" && keySystemOf && typeof keySystemOf.get === "function") {
        const keySystemFrom = guard((access) => apply(keySystemOf.get, access, []));
        const wrappedCreate = asNative(createKeys, (target, self, args) => {
          const result = apply(target, self, args);
          if (!drmSent) {
            const keySystem = keySystemFrom(self);
            if (typeof keySystem === "string" && apply(test, protectedSystem, [keySystem])) {
              const activated = !!(navigator.userActivation && navigator.userActivation.isActive) || grantedOnActivation.has(self);
              apply(then, result, [null, () => onRefused(keySystem, activated)]);
            }
          }
          return result;
        });
        Object.defineProperty(AccessType.prototype, "createMediaKeys", {
          ...Object.getOwnPropertyDescriptor(AccessType.prototype, "createMediaKeys"),
          value: wrappedCreate,
        });
      }
    }
  } catch (e) {}

  try {
    const getterOf = (proto, name) => {
      const get = Object.getOwnPropertyDescriptor(proto, name).get;
      return (o) => apply(get, o, []);
    };
    const withCommand = getterOf(MouseEvent.prototype, "metaKey");
    const cancelable = getterOf(Event.prototype, "cancelable");
    const prevented = getterOf(Event.prototype, "defaultPrevented");
    const deltaY = getterOf(WheelEvent.prototype, "deltaY");
    const cancel = Event.prototype.preventDefault;
    const listen = EventTarget.prototype.addEventListener;
    const unlisten = EventTarget.prototype.removeEventListener;
    const blocking = { passive: false };
    let armed = false;
    const disarm = () => {
      if (!armed) return;
      armed = false;
      apply(unlisten, window, ["wheel", onCommandWheel, blocking]);
    };
    const onCommandWheel = guard((e) => {
      if (!withCommand(e)) return disarm();
      const handled = prevented(e) || !cancelable(e);
      if (!handled) apply(cancel, e, []);
      send("commandWheel", { handled, dy: deltaY(e) });
    });
    handlers.commandWheel = (message) => {
      if (!(message && message.armed)) return disarm();
      if (armed) return;
      armed = true;
      apply(listen, window, ["wheel", onCommandWheel, blocking]);
    };
  } catch (e) {}

  handlers.config = (config) => {
    handlers.peekConfig({ modifier: config.peek, split: config.split, trace: config.peekTrace, otherSites: config.peekOtherSites });
    blockAutoplay = !!config.blockAutoplay;
    pipTrace = !!config.pipTrace;
    if (pipTrace && pipHandlerSet !== null)
      send("pipTrace", { event: "setActionHandler", action: "enterpictureinpicture", set: pipHandlerSet });
    if (blockAutoplay)
      pauseUnasked([...playingMedia, ...document.querySelectorAll("video, audio")], askedToPlay());
    if (config.displayMediaPicker) installDisplayMedia();
    else restoreDisplayMedia();
    if (config.fieldTiming) setFieldTiming(true);
    if (typeof config.selectionPopover === "boolean" && handlers.selectionPopover) handlers.selectionPopover(config.selectionPopover);
  };
  send("hello", { top: isTop, url: location.href, protectedVideo: PROTECTED_VIDEO_ON, started: performance.timeOrigin });

  if (!isTop) return receive;

  let contextMenuAt = null;
  addEventListener(
    "contextmenu",
    (e) => {
      if (e.isTrusted) contextMenuAt = { x: e.clientX, y: e.clientY, at: performance.now() };
    },
    { capture: true, passive: true },
  );
  document.addEventListener("ardia-hide-element", () => {
    const asked = contextMenuAt;
    contextMenuAt = null;
    if (asked && performance.now() - asked.at < 60000) send("hideElement", { x: asked.x, y: asked.y });
  });
  document.addEventListener("ardia-hide-element-in-frame", () => {
    contextMenuAt = null;
    send("hideElement", { x: -1, y: -1 });
  });

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
  const themeTouched = (records) => {
    for (const r of records) {
      if (r.type === "childList") {
        for (const n of r.addedNodes) if (n.nodeName === "META") return true;
        for (const n of r.removedNodes) if (n.nodeName === "META") return true;
      } else if (r.target.nodeName === "META") return true;
      else if ((r.target === document.documentElement || r.target === document.body) && r.oldValue !== r.target.getAttribute(r.attributeName)) return true;
    }
    return false;
  };
  const scheduleTheme = () => {
    metaCache = undefined;
    if (themeQueued) return;
    themeQueued = true;
    nextFrame(() => {
      themeQueued = false;
      reportTheme();
    });
  };
  const startTheme = () => {
    reportTheme();
    const observer = new NativeMutationObserver((records) => themeTouched(records) && scheduleTheme());
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

  if (window.visualViewport) {
    let lastScale = 1;
    visualViewport.addEventListener("resize", () => {
      const scale = Math.round(visualViewport.scale * 100) / 100;
      if (scale === lastScale) return;
      lastScale = scale;
      send("pinch", { scale });
    });
  }

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
  const measureScroll = guard(() => {
    const target = scrollTarget;
    scrollTarget = null;
    const doc = document.scrollingElement || document.documentElement;
    const el = target === document || target === doc ? doc : target;
    if (!el || !doc || (el !== doc && (el.clientHeight < innerHeight * 0.5 || el.clientWidth < innerWidth * 0.5))) return;
    if (el !== scroller) direction.rebase((scroller = el).scrollTop);
    const now = performance.now();
    const style = getComputedStyle(el === doc ? document.documentElement : el);
    const state = direction.scrolled(el.scrollTop, el.scrollHeight - el.clientHeight, innerHeight, now, now - inputAt < 1000, style.scrollSnapType, /^(vertical|sideways)/.test(style.writingMode));
    if (state) send("scroll", { state });
  });
  addEventListener(
    "scroll",
    (e) => {
      if (!scrollTarget) requestAnimationFrame(measureScroll);
      scrollTarget = e.target;
    },
    { passive: true, capture: true },
  );
  addEventListener("resize", () => direction.resized(innerHeight, performance.now()));

  return receive;
})
