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
  const ownOnly = (value, depth) => {
    if (value === null || typeof value !== "object") return value;
    if (depth > 32) return null;
    const out = isArray(value) ? [] : setPrototypeOf({}, null);
    const names = keys(value);
    for (let i = 0; i < names.length; i++) out[names[i]] = ownOnly(value[names[i]], depth + 1);
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
  const controllerTracks = new WeakMap();
  const usedControllers = new WeakSet();
  let zoomLevelsShim = null;
  let nativeZoomLevels = null;
  const controllerProto = () => {
    const Controller = window.CaptureController;
    return typeof Controller === "function" ? Controller.prototype : null;
  };
  const installZoomLevels = () => {
    const proto = controllerProto();
    if (!proto || typeof proto.getSupportedZoomLevels !== "function" || zoomLevelsShim) return;
    const trackProto = window.MediaStreamTrack && window.MediaStreamTrack.prototype;
    const readyState = trackProto && Object.getOwnPropertyDescriptor(trackProto, "readyState");
    const readyStateOf = readyState && readyState.get;
    const settingsOf = trackProto && trackProto.getSettings;
    if (!readyStateOf || !settingsOf) return;
    if (!nativeZoomLevels) nativeZoomLevels = proto.getSupportedZoomLevels;
    zoomLevelsShim = asNative(nativeZoomLevels, (target, self, args) => {
      const track = controllerTracks.get(self);
      if (!track || apply(readyStateOf, track, []) !== "live") return apply(target, self, args);
      if (apply(settingsOf, track, []).displaySurface !== "browser") throw new DOMException("Not a supported surface type.", "NotSupportedError");
      return [];
    });
    proto.getSupportedZoomLevels = zoomLevelsShim;
  };
  const restoreZoomLevels = () => {
    const proto = controllerProto();
    if (!proto || !zoomLevelsShim || proto.getSupportedZoomLevels !== zoomLevelsShim) return;
    proto.getSupportedZoomLevels = nativeZoomLevels;
    zoomLevelsShim = null;
  };
  const restoreDisplayMedia = () => {
    restoreZoomLevels();
    const devices = navigator.mediaDevices;
    const proto = devices && Object.getPrototypeOf(devices);
    if (!proto || !displayMediaShim || proto.getDisplayMedia !== displayMediaShim) return;
    proto.getDisplayMedia = nativeGetDisplayMedia;
    displayMediaShim = null;
  };
  const installDisplayMedia = () => {
    const devices = navigator.mediaDevices;
    const proto = devices && Object.getPrototypeOf(devices);
    if (!proto || !proto.getDisplayMedia) return;
    if (displayMediaShim) {
      installZoomLevels();
      return;
    }
    nativeGetDisplayMedia = proto.getDisplayMedia;
    const getUserMedia = proto.getUserMedia;
    const streamProto = window.MediaStream && window.MediaStream.prototype;
    const videoTracksOf = streamProto && streamProto.getVideoTracks;
    const activation = navigator.userActivation;
    const activationProto = activation && Object.getPrototypeOf(activation);
    const activationState = activationProto && Object.getOwnPropertyDescriptor(activationProto, "isActive");
    const isActive = activationState && activationState.get;
    const policy = document.featurePolicy;
    const allowsFeature = policy && policy.allowsFeature;
    installZoomLevels();
    const isPrototypeOf = Object.prototype.isPrototypeOf;
    const NativeTypeError = TypeError;
    const isController = (value) => {
      if ((typeof value !== "object" && typeof value !== "function") || value === null) return false;
      if (!nativeZoomLevels) {
        const controllerPrototype = controllerProto();
        return !!controllerPrototype && apply(isPrototypeOf, controllerPrototype, [value]);
      }
      try {
        apply(nativeZoomLevels, value, []);
        return true;
      } catch (error) {
        return !(error instanceof NativeTypeError);
      }
    };
    const badController = () =>
      Promise.reject(new NativeTypeError("Failed to execute 'getDisplayMedia' on 'MediaDevices': Failed to read the 'controller' property from 'DisplayMediaStreamOptions': Failed to convert value to 'CaptureController'."));
    const nativeRejects = (self, options) =>
      self !== devices ||
      (options !== undefined && options !== null && typeof options !== "object" && typeof options !== "function") ||
      (policy && allowsFeature && !apply(allowsFeature, policy, ["display-capture"]));
    displayMediaShim = asNative(nativeGetDisplayMedia, (target, self, args) => {
      const constraints = args[0];
      if (nativeRejects(self, constraints)) return apply(target, self, args);
      let controller;
      try {
        controller = constraints !== undefined && constraints !== null ? constraints.controller : undefined;
      } catch (error) {
        return Promise.reject(error);
      }
      if (controller !== undefined) installZoomLevels();
      if (controller !== undefined && !isController(controller)) return badController();
      if (activation && isActive && !apply(isActive, activation, []))
        return Promise.reject(new DOMException("getDisplayMedia() requires transient activation (user gesture).", "InvalidStateError"));
      if (controller !== undefined && usedControllers.has(controller))
        return Promise.reject(new DOMException("A CaptureController object may only be used with a single getDisplayMedia() invocation.", "InvalidStateError"));
      if (controller !== undefined) usedControllers.add(controller);
      return new Promise((resolve, reject) => {
        const id = ++displaySeq;
        const options = constraints || {};
        displayRequests.set(id, { self, resolve, reject, constraints: options, controller });
        const windowAudio = options.windowAudio === "exclude" || options.windowAudio === "window" ? options.windowAudio : "system";
        send("displayMedia", { id, audio: !!options.audio, systemAudio: options.systemAudio !== "exclude", windowAudio, controller: controller !== undefined });
      });
    });
    proto.getDisplayMedia = displayMediaShim;
    const bindController = (controller, stream) => {
      if (controller === undefined || !videoTracksOf) return stream;
      const track = apply(videoTracksOf, stream, [])[0];
      if (track) controllerTracks.set(controller, track);
      return stream;
    };
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
      ]).then((stream) => request.resolve(bindController(request.controller, stream)), request.reject);
    };
  };
  installDisplayMedia();

  const receive = (kind, json) => {
    const handler = handlers[kind];
    if (handler) guard(handler)(ownOnly(fromJSON(json), 0));
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
  HTMLMediaElement.prototype.play = asNative(play, (target, self, args) => {
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
    if (media && blockAutoplay && !askedToPlay())
      return Promise.reject(new DOMException("play() failed because the user didn't interact with the document first.", "NotAllowedError"));
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

  const fieldProviderKit = (env) => {
    const { document, send, guard, later, onReady, revealed, addListener, apply, FrameMutationObserver, setTimeout, addEventListener, requestAnimationFrame, isTop } = env;
    const { charCodeAt, promiseThen, imul, Detector, detect, toRGBA } = env.intrinsics;
    const { rectOf, styleOf, styleValue, parentOf, hitAt, contains, closest, labelControl, ownerDocumentOf, formOf, queryAll, viewport, pinch } = env.intrinsics;
    const USERNAME_TOKEN = /(^|\s)(username|email|webauthn)(\s|$)/i;
    const ONE_TIME_CODE = /(^|\s)one-time-code(\s|$)/i;
    const EMAIL_TOKEN = /(^|\s)email(\s|$)/i;
    const WEBAUTHN_TOKEN = /(^|\s)webauthn(\s|$)/i;
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
    const darkBehind = (backgrounds, text, pageIsDark) => badgeInk(backgrounds, text, pageIsDark) === ON_DARK;
    const BADGE_PROBE = 14;
    const BADGE_PADDING = 20;
    const BRAND_CHROMA = 0.25;
    const BRAND_ACTIONS = 40;
    const COLOR_TOKEN = /(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^()]*\)/gi;
    const FIELD_BRAND = ["outline-color", "border-top-color", "border-bottom-color", "border-left-color", "box-shadow", "caret-color", "accent-color"];
    const RING_BRAND = ["outline-color", "border-top-color", "box-shadow"];
    const ACTION_BRAND = ["background-color", "border-top-color"];
    const px = (style, name) => parseFloat(styleValue(style, name)) || 0;
    const hexByte = (n) => {
      const v = Math.max(0, Math.min(255, Math.round(n)));
      return (v < 16 ? "0" : "") + v.toString(16);
    };
    const brandIn = (text) => {
      if (!text || text === "none") return null;
      for (const token of text.match(COLOR_TOKEN) || []) {
        const c = readColor(token);
        if (!c || !(c.a >= 0.5) || (Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b)) / 255 < BRAND_CHROMA) continue;
        return "#" + hexByte(c.r) + hexByte(c.g) + hexByte(c.b);
      }
      return null;
    };
    const brandOfStyle = (style, names) => {
      for (const name of names) {
        const brand = brandIn(styleValue(style, name));
        if (brand) return brand;
      }
      return null;
    };
    const brandOf = (el) => {
      const own = brandOfStyle(styleOf(el), FIELD_BRAND);
      if (own) return own;
      for (let n = parentOf(el), depth = 0; n && depth < 3; n = parentOf(n), depth++) {
        const ring = brandOfStyle(styleOf(n), RING_BRAND);
        if (ring) return ring;
      }
      const doc = ownerDocumentOf(el);
      const scope = formOf(el) || (doc && doc.documentElement);
      if (!scope) return null;
      const actions = queryAll(scope, "button, [type=submit], a[href]");
      for (let i = 0; i < actions.length && i < BRAND_ACTIONS; i++) {
        const style = styleOf(actions[i]);
        const brand = brandOfStyle(style, ACTION_BRAND) || brandOfStyle(style, ["color"]);
        if (brand) return brand;
      }
      return null;
    };
    const fieldIsDark = (el, style) => {
      const backgrounds = [styleValue(style, "background-color")];
      for (let n = parentOf(el), depth = 0; n && depth < 12; n = parentOf(n), depth++) backgrounds.push(styleValue(styleOf(n), "background-color"));
      return darkBehind(backgrounds, styleValue(style, "color"), pageIsDark);
    };
    const trailingTaken = (el, r, rtl, style) => {
      const x = rtl ? r.left + BADGE_PROBE : r.right - BADGE_PROBE;
      const y = r.top + r.height / 2;
      const hit = x >= 0 && y >= 0 ? hitAt(ownerDocumentOf(el) || document, x, y) : null;
      if (hit && hit !== el && !contains(el, hit)) {
        let ancestor = false;
        for (let n = parentOf(el); n && !ancestor; n = parentOf(n)) ancestor = n === hit;
        const label = ancestor ? null : closest(hit, "label");
        const labelFor = !!label && labelControl(label) === el && !contains(label, el);
        if (!ancestor && !labelFor) return true;
      }
      const image = styleValue(style, "background-image");
      return !!image && image !== "none" && px(style, rtl ? "padding-left" : "padding-right") >= BADGE_PADDING;
    };
    let lookEl = null;
    let look = null;
    let brandEl = null;
    let brand = null;
    const lookOf = (el) => {
      if (lookEl !== el) {
        const style = styleOf(el);
        const rtl = styleValue(style, "direction") === "rtl";
        const side = rtl ? "left" : "right";
        look = {
          style,
          rtl,
          dark: fieldIsDark(el, style),
          inset: {
            top: px(style, "border-top-width") + px(style, "padding-top"),
            bottom: px(style, "border-bottom-width") + px(style, "padding-bottom"),
            trailing: px(style, "border-" + side + "-width") + px(style, "padding-" + side),
          },
        };
        lookEl = el;
      }
      return look;
    };
    const onScreen = (x, y, width, height) => {
      const p = pinch();
      return p ? { x: (x - p.left) * p.scale, y: (y - p.top) * p.scale, width: width * p.scale, height: height * p.scale } : { x, y, width, height };
    };
    const fieldRect = (el) => {
      const r = rectOf(el);
      return onScreen(r.left, r.top, r.width, r.height);
    };
    const fieldLook = (el, dx = 0, dy = 0) => {
      const r = rectOf(el);
      const { style, rtl, dark, inset } = lookOf(el);
      if (brandEl !== el || !brand) {
        brandEl = el;
        brand = brandOf(el);
      }
      const p = pinch();
      const scale = p ? p.scale : 1;
      return {
        rect: onScreen(r.left + dx, r.top + dy, r.width, r.height),
        rtl,
        darkField: dark,
        brandColor: brand,
        trailingTaken: trailingTaken(el, r, rtl, style),
        inset: { top: inset.top * scale, bottom: inset.bottom * scale, trailing: inset.trailing * scale },
      };
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
    let menuListener = null;
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
    const menuMode = () => !!config && config.fill === "menu";
    const systemMode = () => !!config && config.fill !== "menu";
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
      if (!systemMode()) return hideKey();
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
      if (!isTop || !systemMode()) return;
      const kind = loginFieldKind(deepActive(document, 0), revealed());
      const field = wants(kind) ? kind : null;
      if (field !== reportedFocus) sendFocus(field);
    });
    const reportFocusSoon = () => setTimeout(reportFocus, 0);
    const focusQuery = guard((query) => {
      if (!isTop || !systemMode() || typeof query !== "string" || !query || query.length > 64) return;
      const kind = loginFieldKind(deepActive(document, 0), revealed());
      sendFocus(wants(kind) ? kind : null, query);
    });
    const focusGained = () => {
      reportFocus();
      reportFocusSoon();
    };
    const focusLost = guard(() => {
      if (isTop && systemMode() && reportedFocus !== null) sendFocus(null);
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
    const tellMenu = (on) => {
      if (menuListener) menuListener(on);
    };
    const configure = (state) => {
      const next =
        state && typeof state === "object"
          ? {
              login: state.login === true,
              oneTimeCode: state.oneTimeCode === true,
              codeSetup: state.codeSetup === true,
              generation: typeof state.generation === "number" ? state.generation : 0,
              fill: state.fill === "menu" ? "menu" : "system",
            }
          : null;
      const previous = config;
      const wasMenu = menuMode();
      const accepted = next && (next.login || next.oneTimeCode || next.codeSetup) ? next : null;
      const nowMenu = !!accepted && accepted.fill === "menu";
      if (wasMenu && !nowMenu) tellMenu(false);
      config = accepted;
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
      if (nowMenu && !wasMenu) tellMenu(true);
    };
    const onMenuMode = (listener) => {
      menuListener = typeof listener === "function" ? listener : null;
    };
    return {
      configure,
      focusQuery,
      hint: guard((state) => (state ? showHint(state) : hideHint())),
      menuMode,
      onMenuMode,
      fieldLook,
      fieldRect,
      badgeInk,
      darkBehind,
      hasOwnToggle,
      loginFieldKind,
      verificationSetupURL,
      codeKey,
      rememberedCodes: () => found.size,
    };
  };
  const fieldProviderIntrinsics = (scope) => {
    const call = Reflect.apply;
    const describe = Object.getOwnPropertyDescriptor;
    const accessor = (proto, name, kind) => (proto && describe(proto, name) ? describe(proto, name)[kind] : undefined);
    const protoOf = (name) => (typeof scope[name] === "function" ? scope[name].prototype : null);
    const getter = (proto, name) => {
      const read = accessor(proto, name, "get");
      return read ? (o) => call(read, o, []) : (o) => o[name];
    };
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
    const elementProto = protoOf("Element");
    const nodeProto = protoOf("Node");
    const getRect = elementProto && elementProto.getBoundingClientRect;
    const computedStyle = scope.getComputedStyle;
    const propertyValue = scope.CSSStyleDeclaration && scope.CSSStyleDeclaration.prototype.getPropertyValue;
    const pointHit = protoOf("Document") && protoOf("Document").elementFromPoint;
    const nodeContains = nodeProto && nodeProto.contains;
    const elementClosest = elementProto && elementProto.closest;
    const queryAllOf = elementProto && elementProto.querySelectorAll;
    const parentNodeOf = getter(nodeProto, "parentNode");
    const nodeTypeOf = getter(nodeProto, "nodeType");
    const hostOf = getter(protoOf("ShadowRoot"), "host");
    const inputForm = accessor(protoOf("HTMLInputElement"), "form", "get");
    const viewport = scope.visualViewport || null;
    const viewportProto = protoOf("VisualViewport");
    const viewportScale = accessor(viewportProto, "scale", "get");
    const viewportLeft = accessor(viewportProto, "offsetLeft", "get");
    const viewportTop = accessor(viewportProto, "offsetTop", "get");
    return {
      charCodeAt: String.prototype.charCodeAt,
      promiseThen: Promise.prototype.then,
      imul: Math.imul,
      Detector: typeof detect === "function" ? Detector : null,
      detect,
      toRGBA,
      rectOf: (el) => call(getRect, el, []),
      styleOf: (el) => call(computedStyle, scope, [el]),
      styleValue: (style, name) => (style ? "" + (call(propertyValue, style, [name]) || "") : ""),
      parentOf: (node) => {
        const parent = parentNodeOf(node);
        if (!parent) return null;
        const kind = nodeTypeOf(parent);
        return kind === 1 ? parent : kind === 11 ? hostOf(parent) || null : null;
      },
      hitAt: (doc, x, y) => (pointHit ? call(pointHit, doc, [x, y]) : null),
      contains: (outer, inner) => !!nodeContains && !!call(nodeContains, outer, [inner]),
      closest: (el, selector) => {
        try {
          return elementClosest ? call(elementClosest, el, [selector]) : null;
        } catch {
          return null;
        }
      },
      labelControl: getter(protoOf("HTMLLabelElement"), "control"),
      ownerDocumentOf: getter(nodeProto, "ownerDocument"),
      formOf: (el) => {
        try {
          return inputForm ? call(inputForm, el, []) : null;
        } catch {
          return null;
        }
      },
      queryAll: (root, selector) => call(queryAllOf, root, [selector]),
      viewport,
      pinch: () => {
        if (!viewport || !viewportScale) return null;
        const scale = call(viewportScale, viewport, []);
        if (!(scale > 0) || scale === 1) return null;
        return { scale, left: (viewportLeft && call(viewportLeft, viewport, [])) || 0, top: (viewportTop && call(viewportTop, viewport, [])) || 0 };
      },
    };
  };
  const nativeMutationObserver = window.MutationObserver;
  const nativeAddListener = EventTarget.prototype.addEventListener;
  const fieldIntrinsics = fieldProviderIntrinsics(window);
  const fieldProviders = fieldProviderKit({
    document,
    send,
    guard,
    later,
    onReady,
    revealed: () => revealedField,
    addListener: nativeAddListener,
    apply,
    FrameMutationObserver: nativeMutationObserver,
    setTimeout,
    addEventListener,
    requestAnimationFrame,
    isTop,
    intrinsics: fieldIntrinsics,
  });
  handlers.fieldProvider = fieldProviders.configure;
  handlers.fieldFocusQuery = (message) => fieldProviders.focusQuery(message && message.query);
  handlers.fieldProviderHint = fieldProviders.hint;
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
  const { hasOwnToggle } = fieldProviders;
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

  try {
    const vaultValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    const vaultSetValue = vaultValue.set;
    const vaultGetValue = vaultValue.get;
    const vaultFormOf = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "form").get;
    const vaultCheckedOf = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked").get;
    const vaultMaxLengthOf = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "maxLength").get;
    const vaultRequestSubmit = HTMLFormElement.prototype.requestSubmit;
    const vaultClick = HTMLElement.prototype.click;
    const vaultStyleProperty = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "style");
    const vaultInlineStyleOf = vaultStyleProperty && vaultStyleProperty.get;
    const vaultCSSValue = CSSStyleDeclaration.prototype.getPropertyValue;
    const vaultCSSPriority = CSSStyleDeclaration.prototype.getPropertyPriority;
    const vaultCSSSet = CSSStyleDeclaration.prototype.setProperty;
    const vaultCSSRemove = CSSStyleDeclaration.prototype.removeProperty;
    const VaultKeyboardEvent = KeyboardEvent;
    const vaultGetterOf = (proto, name) => {
      const property = proto ? Object.getOwnPropertyDescriptor(proto, name) : null;
      const read = property && property.get;
      return read ? (o) => apply(read, o, []) : (o) => o[name];
    };
    const vaultKeyOf = vaultGetterOf(VaultKeyboardEvent.prototype, "key");
    const vaultAltOf = vaultGetterOf(VaultKeyboardEvent.prototype, "altKey");
    const vaultCtrlOf = vaultGetterOf(VaultKeyboardEvent.prototype, "ctrlKey");
    const vaultMetaOf = vaultGetterOf(VaultKeyboardEvent.prototype, "metaKey");
    const vaultShiftOf = vaultGetterOf(VaultKeyboardEvent.prototype, "shiftKey");
    const vaultDefine = Object.defineProperty;
    const vaultTimer = window.setTimeout;
    const vaultClearTimer = window.clearTimeout;
    const vaultMedia = window.matchMedia;
    const vaultTrim = String.prototype.trim;
    const vaultDispatch = EventTarget.prototype.dispatchEvent;
    const vaultListen = EventTarget.prototype.addEventListener;
    const VaultEvent = Event;
    const vaultPathOf = Event.prototype.composedPath;
    const vaultPrevent = Event.prototype.preventDefault;
    const vaultStopNow = Event.prototype.stopImmediatePropagation;
    const vaultRectOf = Element.prototype.getBoundingClientRect;
    const vaultAttrOf = Element.prototype.getAttribute;
    const vaultClosest = Element.prototype.closest;
    const vaultQuery = Element.prototype.querySelectorAll;
    const vaultFragmentQuery = DocumentFragment.prototype.querySelectorAll;
    const vaultFocusOn = HTMLElement.prototype.focus;
    const vaultStyleOf = window.getComputedStyle;
    const vaultNextFrame = window.requestAnimationFrame;
    const vaultNow = Date.now;
    const vaultLower = String.prototype.toLowerCase;
    const vaultSplit = String.prototype.split;
    const vaultReplace = String.prototype.replace;
    const vaultOrigin = () => location.origin;
    const vaultExec = RegExp.prototype.exec;
    const vaultSetProto = Object.setPrototypeOf;
    const vaultIsArray = Array.isArray;
    const VaultText = String;
    const vaultSliceText = String.prototype.slice;
    const vaultCharCodeAt = String.prototype.charCodeAt;
    const vaultFromCharCode = String.fromCharCode;
    const vaultParseNumber = parseFloat;
    const vaultParseWhole = parseInt;
    const vaultMin = Math.min;
    const vaultSortList = Array.prototype.sort;
    const vaultHasInstance = Function.prototype[Symbol.hasInstance];
    const VaultInputElement = HTMLInputElement;
    const VaultInputEvent = typeof InputEvent === "function" ? InputEvent : Event;
    const VaultWeakSet = WeakSet;
    const vaultSetHas = WeakSet.prototype.has;
    const vaultSetAdd = WeakSet.prototype.add;
    const vaultSetDelete = WeakSet.prototype.delete;
    const VaultWeakMap = WeakMap;
    const vaultMapGet = WeakMap.prototype.get;
    const vaultMapSet = WeakMap.prototype.set;
    const vaultMapDelete = WeakMap.prototype.delete;
    const vaultMarks = () => {
      const marks = new VaultWeakSet();
      return {
        has: (item) => apply(vaultSetHas, marks, [item]),
        add: (item) => void apply(vaultSetAdd, marks, [item]),
        delete: (item) => void apply(vaultSetDelete, marks, [item]),
      };
    };
    const vaultTable = () => {
      const table = new VaultWeakMap();
      return {
        get: (key) => apply(vaultMapGet, table, [key]),
        set: (key, value) => void apply(vaultMapSet, table, [key, value]),
        delete: (key) => void apply(vaultMapDelete, table, [key]),
      };
    };
    const vaultList = () => vaultSetProto([], null);
    const vaultAdd = (list, item) => {
      list[list.length] = item;
      return list;
    };
    const vaultListOf = (items, count) => {
      const out = vaultList();
      const n = count === undefined ? (items ? items.length : 0) : count;
      for (let i = 0; i < n; i++) {
        const item = items[i];
        if (item !== undefined && item !== null) out[out.length] = item;
      }
      return out;
    };
    const vaultFilter = (list, keep) => {
      const out = vaultList();
      for (let i = 0; i < list.length; i++) if (keep(list[i])) out[out.length] = list[i];
      return out;
    };
    const vaultMap = (list, change) => {
      const out = vaultList();
      for (let i = 0; i < list.length; i++) out[out.length] = change(list[i]);
      return out;
    };
    const vaultFind = (list, test) => {
      for (let i = 0; i < list.length; i++) if (test(list[i])) return list[i];
      return undefined;
    };
    const vaultSome = (list, test) => {
      for (let i = 0; i < list.length; i++) if (test(list[i])) return true;
      return false;
    };
    const vaultIndexOf = (list, item) => {
      for (let i = 0; i < list.length; i++) if (list[i] === item) return i;
      return -1;
    };
    const vaultIncludes = (list, item) => vaultIndexOf(list, item) >= 0;
    const vaultAddOnce = (list, item) => {
      if (!vaultIncludes(list, item)) list[list.length] = item;
    };
    const vaultFrom = (list, start) => {
      const out = vaultList();
      for (let i = start; i < list.length; i++) out[out.length] = list[i];
      return out;
    };
    const vaultJoin = (list, separator) => {
      let text = "";
      for (let i = 0; i < list.length; i++) text += (i ? separator : "") + list[i];
      return text;
    };
    const vaultSorted = (list, compare) => {
      apply(vaultSortList, list, [compare]);
      return list;
    };
    const vaultSlice = (text, start, end) => apply(vaultSliceText, text, end === undefined ? [start] : [start, end]);
    const vaultIsSpace = (code) => code === 32 || (code >= 9 && code <= 13);

    const vaultHas = (re, text) => apply(vaultExec, re, [text]) !== null;
    const vaultWords = (text) => {
      const source = VaultText(text || "");
      let out = "";
      let joiner = false;
      for (let i = 0; i < source.length; i++) {
        const code = apply(vaultCharCodeAt, source, [i]);
        if (code === 95 || code === 45) {
          joiner = true;
          continue;
        }
        if (joiner) {
          out += " ";
          joiner = false;
        }
        const previous = i > 0 ? apply(vaultCharCodeAt, source, [i - 1]) : 0;
        if (code >= 65 && code <= 90 && previous >= 97 && previous <= 122) out += " ";
        out += apply(vaultFromCharCode, null, [code]);
      }
      if (joiner) out += " ";
      return apply(vaultLower, out, []);
    };
    const vaultOtherToken =
      /^(name|honorific-.+|given-name|additional-name|family-name|nickname|organization.*|street-address|address-.+|country.*|postal-code|cc-.+|transaction-.+|language|bday.*|sex|url|photo|tel.*|impp|email-confirm)$/;
    const VAULT_USER =
      /user|login|log.?on|sign.?in|account.?(name|id)|\baccount\b|identifier|e.?mail|\bmail\b|\buid\b|loginfmt|benutzer|usuario|utilisateur|identifiant|courriel|correo/;
    const VAULT_EMAIL = /e.?mail|\bmail\b|courriel|correo/;
    const VAULT_NOT_LOGIN =
      /search|query|first.?name|last.?name|full.?name|given|family|surname|company|organi[sz]ation|address|street|city|zip|postal|country|coupon|promo|captcha|subject|message|comment|card|cvc|cvv|iban|routing|account.?(number|no\b)|newsletter|subscribe/;
    const VAULT_OTP_STRONG = /one.?time|\botp\b|otp.?code|totp|\b2fa\b|two.?factor|\bmfa\b|authenticator|auth.?app|passcode|verification.?code|security.?code|auth.?code|login.?code|sms.?code/;
    const VAULT_OTP_WEAK = /code|token|verif|\bpin\b|digits|challenge/;
    const VAULT_OTP_NOT = /zip|postal|promo|coupon|discount|gift|referral|invite|country|area|voucher|product|tracking|post.?code|captcha|color|colour|qr/;
    const VAULT_NEW_PASSWORD = /new|confirm|repeat|retype|re.?enter|again|create|sign.?up|regist|choose|second|password.?2\b|verify.?pass/;
    const VAULT_CURRENT_PASSWORD = /current|\bold\b|old.?pass|existing/;
    const VAULT_CONFIRM_PASSWORD = /confirm|repeat|retype|re.?enter|again|verify|second|password.?2\b/;
    const VAULT_SIGNUP = /sign.?up|regist|create.?(an.?|your.?)?account|join|enrol|new.?account|get.?started/;
    const VAULT_LOGIN = /log.?in|sign.?in|log.?on|auth|session|identifier|account/;
    const VAULT_LOGIN_PAGE = /log.?in|sign.?in|log.?on|auth|identifier/;
    const VAULT_TEXT_TYPES = ["text", "email", "tel", "url", "number", "password", ""];
    const VAULT_EDITABLE_TYPES = [...VAULT_TEXT_TYPES, "search"];
    const VAULT_LONGEST_VALUE = 4096;
    const VAULT_LONGEST_USERNAME = 1024;
    const vaultFillable = (value) => typeof value === "string" && value.length > 0 && value.length <= VAULT_LONGEST_VALUE;

    const vaultTokens = (autocomplete) => {
      const text = apply(vaultLower, VaultText(autocomplete || ""), []);
      const tokens = vaultList();
      let token = "";
      for (let i = 0; i <= text.length; i++) {
        const code = i < text.length ? apply(vaultCharCodeAt, text, [i]) : 32;
        if (!vaultIsSpace(code)) {
          token += apply(vaultFromCharCode, null, [code]);
          continue;
        }
        if (token && token !== "webauthn") vaultAdd(tokens, token);
        token = "";
      }
      return tokens.length ? tokens[tokens.length - 1] : "";
    };

    const vaultClassify = (d) => {
      const type = d.type || "text";
      if (!vaultIncludes(VAULT_TEXT_TYPES, type)) return null;
      const hints = vaultWords(d.hints);
      const formContext = vaultWords(d.formContext);
      const context = formContext + " " + (d.pageContext || "");
      const token = vaultTokens(d.autocomplete);
      const loginContext = vaultHas(VAULT_LOGIN, formContext) || vaultHas(VAULT_LOGIN_PAGE, d.pageContext || "");
      const signupContext = vaultHas(VAULT_SIGNUP, formContext);
      if (token === "one-time-code") return "otp";
      if (type === "password") {
        if (token === "current-password") return "password";
        if (token === "new-password") return "newPassword";
        if (vaultHas(VAULT_OTP_STRONG, hints) && d.passwordCount < 2) return "otp";
        if (vaultHas(VAULT_CURRENT_PASSWORD, hints)) return "password";
        if (vaultHas(VAULT_NEW_PASSWORD, hints)) return "newPassword";
        if (d.passwordCount >= 3) return d.passwordIndex === 0 ? "password" : "newPassword";
        if (d.passwordCount === 2) return !d.otherPasswordCurrent && d.otherPasswordFresh && !signupContext ? "password" : "newPassword";
        return signupContext && !vaultHas(/log.?in|sign.?in/, formContext) ? "newPassword" : "password";
      }
      if (token === "current-password" || token === "new-password") return null;
      if (d.splitRun) return "otp";
      if (token === "username") return "username";
      if (token === "email") return d.passwordCount > 0 || loginContext || vaultHas(VAULT_USER, hints) ? "username" : null;
      if (token && vaultHas(vaultOtherToken, token)) return null;
      const numeric = d.inputMode === "numeric" || d.inputMode === "decimal" || type === "tel" || type === "number" || vaultHas(/\\d|\[0-9\]/, d.pattern || "");
      const shortCode = d.maxLength >= 4 && d.maxLength <= 10;
      if (!vaultHas(VAULT_OTP_NOT, hints)) {
        if (vaultHas(VAULT_OTP_STRONG, hints)) return "otp";
        if (vaultHas(VAULT_OTP_WEAK, hints) && (numeric || shortCode)) return "otp";
        if (numeric && d.maxLength >= 6 && d.maxLength <= 8 && vaultHas(VAULT_OTP_WEAK, hints + " " + context)) return "otp";
      }
      if (type === "number") return null;
      if (vaultHas(VAULT_NOT_LOGIN, hints) && !vaultHas(/user|login|sign.?in|identifier/, hints)) return null;
      if (vaultHas(VAULT_USER, hints) && !vaultHas(VAULT_EMAIL, hints)) return type === "url" ? null : "username";
      if (vaultHas(VAULT_EMAIL, hints) || type === "email") return d.passwordCount > 0 || loginContext ? "username" : null;
      if (d.precedesPassword && type !== "url") return "username";
      return null;
    };

    const vaultAttr = (el, name) => {
      const value = apply(vaultAttrOf, el, [name]);
      return typeof value === "string" ? value : "";
    };
    const vaultLowered = (text) => apply(vaultLower, VaultText(text || ""), []);
    const vaultProtoOf = (name) => (typeof globalThis[name] === "function" ? globalThis[name].prototype : null);
    const vaultInputType = vaultGetterOf(HTMLInputElement.prototype, "type");
    const vaultInputDisabled = vaultGetterOf(HTMLInputElement.prototype, "disabled");
    const vaultInputReadOnly = vaultGetterOf(HTMLInputElement.prototype, "readOnly");
    const vaultParentNodeOf = vaultGetterOf(vaultProtoOf("Node"), "parentNode");
    const vaultNodeTypeOf = vaultGetterOf(vaultProtoOf("Node"), "nodeType");
    const vaultHostOf = vaultGetterOf(vaultProtoOf("ShadowRoot"), "host");
    const vaultContains = (vaultProtoOf("Node") || {}).contains;
    const vaultDocumentElement = vaultGetterOf(vaultProtoOf("Document"), "documentElement");
    const vaultIsConnected = vaultGetterOf(vaultProtoOf("Node"), "isConnected");
    const vaultTagOf = vaultGetterOf(Element.prototype, "tagName");
    const vaultShadowRootOf = vaultGetterOf(Element.prototype, "shadowRoot");
    const vaultLabelsOf = vaultGetterOf(HTMLInputElement.prototype, "labels");
    const vaultLabelControlOf = vaultGetterOf(vaultProtoOf("HTMLLabelElement"), "control");
    const vaultSelectionStartOf = vaultGetterOf(HTMLInputElement.prototype, "selectionStart");
    const vaultSelectionEndOf = vaultGetterOf(HTMLInputElement.prototype, "selectionEnd");
    const vaultScrollWidthOf = vaultGetterOf(Element.prototype, "scrollWidth");
    const vaultScrollHeightOf = vaultGetterOf(Element.prototype, "scrollHeight");
    const vaultCountOf = (() => {
      const list = vaultProtoOf("NodeList");
      const property = list ? Object.getOwnPropertyDescriptor(list, "length") : null;
      const read = property && property.get;
      return (items) => (!items ? 0 : read && typeof items === "object" && !vaultIsArray(items) ? apply(read, items, []) : items.length);
    })();
    const vaultTextContentOf = vaultGetterOf(vaultProtoOf("Node"), "textContent");
    const vaultChildCountOf = vaultGetterOf(Element.prototype, "childElementCount");
    const vaultMatchesSelector = Element.prototype.matches;
    const vaultDisabled = (el) => {
      try {
        return !!apply(vaultMatchesSelector, el, [":disabled"]);
      } catch (e) {
        return apply(vaultAttrOf, el, ["disabled"]) !== null;
      }
    };
    const VAULT_USERNAME_TYPES = ["text", "email", "tel", ""];
    const vaultElementFromPoint = (vaultProtoOf("Document") || {}).elementFromPoint || document.elementFromPoint;
    const vaultIsInput = (el) => !!el && typeof el === "object" && apply(vaultHasInstance, VaultInputElement, [el]);
    const vaultTypeOf = (el) => vaultLowered((vaultIsInput(el) ? vaultInputType(el) : el.type) || "text");
    const vaultValueOf = (el) => apply(vaultGetValue, el, []) || "";
    const vaultParentOf = (node) => {
      const parent = vaultParentNodeOf(node);
      if (!parent) return null;
      const kind = vaultNodeTypeOf(parent);
      if (kind === 1) return parent;
      return kind === 11 ? vaultHostOf(parent) || null : null;
    };
    const VAULT_SMALLEST = 8;
    const VAULT_FAINTEST = 0.05;
    const VAULT_ANCESTORS = 48;
    const vaultStyleValue = (style, name) => (style ? VaultText(apply(vaultCSSValue, style, [name]) || "") : "");
    const vaultFilterOpacity = (filter) => {
      let value = 1;
      const opacity = /opacity\(\s*([\d.]+)(%?)\s*\)/g;
      for (let m = apply(vaultExec, opacity, [filter]); m; m = apply(vaultExec, opacity, [filter])) {
        const amount = vaultParseNumber(m[1]) / (m[2] ? 100 : 1);
        if (amount >= 0) value *= vaultMin(amount, 1);
      }
      return value;
    };
    const vaultOpacityOf = (style) => {
      const value = vaultParseNumber(vaultStyleValue(style, "opacity"));
      return (value >= 0 ? value : 1) * vaultFilterOpacity(vaultStyleValue(style, "filter"));
    };
    const vaultScrollOf = (name) => {
      const property = Object.getOwnPropertyDescriptor(window, name);
      const read = property && property.get;
      return () => (read ? apply(read, window, []) : window[name]) || 0;
    };
    const vaultScrollX = vaultScrollOf("scrollX");
    const vaultScrollY = vaultScrollOf("scrollY");
    const vaultViewWidth = vaultScrollOf("innerWidth");
    const vaultViewHeight = vaultScrollOf("innerHeight");
    const vaultOffscreen = (r) => {
      const left = r.left + vaultScrollX();
      const top = r.top + vaultScrollY();
      if (left + r.width <= 0 || top + r.height <= 0) return true;
      const root = vaultDocumentElement(document);
      const wide = root ? vaultScrollWidthOf(root) : 0;
      const tall = root ? vaultScrollHeightOf(root) : 0;
      return (wide > 0 && left >= wide) || (tall > 0 && top >= tall);
    };
    const vaultCovered = (el, r) => {
      if (typeof vaultElementFromPoint !== "function") return false;
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      if (x < 0 || y < 0 || x >= vaultViewWidth() || y >= vaultViewHeight()) return false;
      const hit = apply(vaultElementFromPoint, document, [x, y]);
      if (!hit || hit === el) return false;
      for (let node = vaultParentOf(el); node; node = vaultParentOf(node)) if (node === hit) return false;
      if (vaultContains && apply(vaultContains, el, [hit])) return false;
      const label = vaultNodeTypeOf(hit) === 1 ? apply(vaultClosest, hit, ["label"]) : null;
      return !(label && vaultLabelControlOf(label) === el);
    };
    const VAULT_MASKS = ["clip-path", "mask-image", "-webkit-mask-image"];
    const vaultMasked = (style) =>
      vaultSome(VAULT_MASKS, (name) => {
        const value = vaultStyleValue(style, name);
        return !!value && value !== "none";
      });
    const vaultClipsTiny = (node, style) => {
      const overflow = vaultStyleValue(style, "overflow");
      if (!overflow || overflow === "visible") return false;
      const box = apply(vaultRectOf, node, []);
      return !!box && (box.width < VAULT_SMALLEST || box.height < VAULT_SMALLEST);
    };
    const vaultShowingOf = (node, depth) => {
      if (!node || depth >= VAULT_ANCESTORS) return 1;
      const known = vaultPass ? vaultPass.showing.get(node) : undefined;
      if (known !== undefined) return known;
      const style = apply(vaultStyleOf, window, [node]);
      const showing = vaultClipsTiny(node, style) ? 0 : vaultOpacityOf(style) * vaultShowingOf(vaultParentOf(node), depth + 1);
      if (vaultPass) vaultPass.showing.set(node, showing);
      return showing;
    };
    const vaultConcealedByAncestor = (el) => vaultShowingOf(vaultParentOf(el), 0) < VAULT_FAINTEST;
    const vaultHidden = (el) => {
      const input = vaultIsInput(el);
      if ((input ? vaultInputDisabled(el) || vaultInputReadOnly(el) : vaultDisabled(el)) || vaultTypeOf(el) === "hidden") return true;
      const r = apply(vaultRectOf, el, []);
      if (!r || r.width < VAULT_SMALLEST || r.height < VAULT_SMALLEST || vaultOffscreen(r)) return true;
      const style = apply(vaultStyleOf, window, [el]);
      const visibility = vaultStyleValue(style, "visibility");
      if (visibility === "hidden" || visibility === "collapse" || vaultStyleValue(style, "display") === "none" || vaultOpacityOf(style) < VAULT_FAINTEST) return true;
      if (input && vaultMasked(style)) return true;
      if (apply(vaultClosest, el, ['[aria-hidden="true"], [inert], [role="search"]'])) return true;
      return vaultConcealedByAncestor(el) || vaultCovered(el, r);
    };
    let vaultPass = null;
    const vaultInOnePass = (fn) =>
      function () {
        if (vaultPass) return apply(fn, this, arguments);
        vaultPass = { usable: vaultTable(), inputs: vaultTable(), showing: vaultTable() };
        try {
          return apply(fn, this, arguments);
        } finally {
          vaultPass = null;
        }
      };
    const vaultGuard = (fn) => guard(vaultInOnePass(fn));
    const vaultUsable = (el) => {
      if (!vaultIsInput(el)) return false;
      const known = vaultPass ? vaultPass.usable.get(el) : undefined;
      if (known !== undefined) return known;
      const usable = !vaultHidden(el);
      if (vaultPass) vaultPass.usable.set(el, usable);
      return usable;
    };
    const vaultNodes = (root, query, selector) => {
      const found = apply(query, root, [selector]);
      return vaultListOf(found, vaultCountOf(found));
    };
    const vaultInputsUncached = (scope) => {
      if (vaultIsInput(scope)) return vaultAdd(vaultList(), scope);
      const light = vaultNodes(scope, vaultQuery, "input");
      if (light.length > 40) return light;
      const found = vaultList();
      const visit = (root, query, depth) => {
        const all = vaultNodes(root, query, "*");
        if (all.length > 2000) {
          if (root === scope) for (let i = 0; i < light.length; i++) vaultAdd(found, light[i]);
          return;
        }
        for (let i = 0; i < all.length; i++) {
          const el = all[i];
          if (vaultIsInput(el)) vaultAdd(found, el);
          else if (depth < 4) {
            const shadow = vaultShadowRootOf(el);
            if (shadow) visit(shadow, vaultFragmentQuery, depth + 1);
          }
        }
      };
      visit(scope, vaultQuery, 0);
      return found;
    };
    const vaultInputsIn = (scope) => {
      const known = vaultPass ? vaultPass.inputs.get(scope) : undefined;
      if (known) return vaultFrom(known, 0);
      const found = vaultInputsUncached(scope);
      if (vaultPass) vaultPass.inputs.set(scope, found);
      return vaultFrom(found, 0);
    };
    const vaultUsableIn = (scope) => vaultFilter(vaultInputsIn(scope), vaultUsable);
    const vaultIsPassword = (el) => vaultTypeOf(el) === "password" || el === revealedField;
    const VAULT_CONTAINER_MOST_INPUTS = 256;
    const vaultCrowded = (node) => vaultInputsIn(node).length > VAULT_CONTAINER_MOST_INPUTS;
    const vaultContainerOf = (el) => {
      const form = vaultIsInput(el) ? apply(vaultFormOf, el, []) : apply(vaultClosest, el, ["form"]);
      if (form && !vaultCrowded(form)) return form;
      let best = null;
      for (let node = vaultParentOf(el), depth = 0; node && depth < 8 && !vaultCrowded(node); node = vaultParentOf(node), depth++) {
        const inputs = vaultUsableIn(node);
        if (inputs.length > 24) break;
        if (vaultSome(inputs, vaultIsPassword)) return node;
        if (!best && inputs.length > 1) best = node;
      }
      const parent = vaultParentOf(el);
      return best || (parent && !vaultCrowded(parent) ? parent : el);
    };
    const vaultTextOf = (el, max) => {
      const content = el ? vaultTextContentOf(el) : "";
      const text = typeof content === "string" ? content : "";
      return text.length > max ? vaultSlice(text, 0, max) : text;
    };
    const vaultHintsOf = (el) => {
      const parts = [vaultAttr(el, "name"), vaultAttr(el, "id"), vaultAttr(el, "placeholder"), vaultAttr(el, "aria-label"), vaultAttr(el, "title"), vaultAttr(el, "data-testid")];
      const labels = vaultIsInput(el) ? vaultLabelsOf(el) : null;
      if (labels) for (let i = 0, n = vaultCountOf(labels); i < n && i < 3; i++) vaultAdd(parts, vaultTextOf(labels[i], 80));
      return vaultJoin(parts, " ");
    };
    const vaultFormContextOf = (scope) => {
      const parts = [vaultAttr(scope, "id"), vaultAttr(scope, "name"), vaultAttr(scope, "action"), vaultAttr(scope, "class"), vaultAttr(scope, "aria-label")];
      const buttons = vaultNodes(scope, vaultQuery, 'button, input[type="submit"], [role="button"]');
      for (let i = 0; i < buttons.length && i < 4; i++) {
        vaultAdd(parts, vaultTextOf(buttons[i], 40));
        vaultAdd(parts, vaultAttr(buttons[i], "value"));
      }
      return vaultJoin(parts, " ");
    };
    const vaultSplitRunOf = (el) => {
      if (vaultAttr(el, "maxlength") !== "1") return null;
      for (let node = vaultParentOf(el), depth = 0; node && depth < 3; node = vaultParentOf(node), depth++) {
        const run = vaultFilter(vaultInputsIn(node), (i) => vaultAttr(i, "maxlength") === "1" && vaultTypeOf(i) !== "password" && vaultUsable(i));
        if (run.length >= 4 && run.length <= 8 && vaultIncludes(run, el)) return run;
        if (run.length > 8) return null;
      }
      return null;
    };
    const vaultDescribe = (el, scope, inputs) => {
      const passwords = vaultFilter(inputs, vaultIsPassword);
      const index = vaultIndexOf(passwords, el);
      const others = vaultMap(vaultFilter(passwords, (p) => p !== el), (p) => vaultWords(vaultHintsOf(p)));
      const firstPassword = passwords.length ? vaultIndexOf(inputs, passwords[0]) : -1;
      let precedesPassword = false;
      if (firstPassword > 0 && !vaultIsPassword(el)) {
        for (let i = firstPassword - 1; i >= 0; i--) {
          const candidate = inputs[i];
          if (!vaultIncludes(VAULT_USERNAME_TYPES, vaultTypeOf(candidate))) continue;
          precedesPassword = candidate === el;
          break;
        }
      }
      const maxLength = vaultParseWhole(vaultAttr(el, "maxlength"), 10);
      return {
        type: vaultTypeOf(el) === "text" && el === revealedField ? "password" : vaultTypeOf(el),
        autocomplete: vaultAttr(el, "autocomplete"),
        hints: vaultHintsOf(el),
        inputMode: vaultLowered(vaultAttr(el, "inputmode")),
        pattern: vaultAttr(el, "pattern"),
        maxLength: maxLength > 0 ? maxLength : -1,
        passwordCount: passwords.length,
        passwordIndex: index,
        otherPasswordCurrent: vaultSome(others, (h) => vaultHas(VAULT_CURRENT_PASSWORD, h)),
        otherPasswordFresh: vaultSome(others, (h) => vaultHas(/new/, h) && !vaultHas(VAULT_CONFIRM_PASSWORD, h)),
        precedesPassword,
        splitRun: !!vaultSplitRunOf(el),
        formContext: vaultFormContextOf(scope),
        pageContext: vaultLowered(location.hostname + location.pathname),
      };
    };
    const vaultFieldsIn = (scope) => {
      const inputs = vaultUsableIn(scope);
      const fields = vaultList();
      for (let i = 0; i < inputs.length; i++) {
        const el = inputs[i];
        const kind = vaultClassify(vaultDescribe(el, scope, inputs));
        if (kind) vaultAdd(fields, { el, kind });
      }
      return { inputs, fields, hasPassword: vaultSome(inputs, vaultIsPassword) };
    };
    const vaultKindOf = (el) => {
      if (!vaultUsable(el)) return null;
      const scope = vaultContainerOf(el);
      const inputs = vaultUsableIn(scope);
      vaultAddOnce(inputs, el);
      const kind = vaultClassify(vaultDescribe(el, scope, inputs));
      if (!kind) return null;
      const maxLength = apply(vaultMaxLengthOf, el, []);
      return {
        kind,
        formHasPassword: vaultSome(inputs, vaultIsPassword),
        maxLength: typeof maxLength === "number" && maxLength > 0 ? maxLength : 0,
        email: kind === "username" && (vaultTypeOf(el) === "email" || vaultTokens(vaultAttr(el, "autocomplete")) === "email" || vaultHas(VAULT_EMAIL, vaultWords(vaultHintsOf(el)))),
      };
    };

    const vaultTyped = vaultMarks();
    const vaultFilledByUs = vaultMarks();
    let vaultLastField = null;
    let vaultLastInfo = null;
    let vaultFocused = null;
    let vaultFocusedInfo = null;
    let vaultMenuOpen = false;
    let vaultFiltering = null;
    const VAULT_LONGEST_TYPED = 256;
    let vaultMenuHighlighted = false;
    let vaultClearedSent = false;
    let vaultRectQueued = false;
    let vaultStepUser = null;
    let vaultLastSubmit = null;

    const vaultTargetOf = (e) => {
      const path = apply(vaultPathOf, e, []);
      return path && path.length ? path[0] : e.target;
    };
    const vaultViewport = window.visualViewport || null;
    const vaultRect = (el) => (isTop ? fieldProviders.fieldRect(el) : null);
    let vaultSentRect = null;
    let vaultFocusAuto = false;
    const vaultSameRect = (a, b) => !!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
    const vaultReport = (el, info, focused, clicked) => {
      if (!fieldProviders.menuMode()) return;
      const look = focused && isTop ? fieldProviders.fieldLook(el) : null;
      vaultSentRect = look ? look.rect : null;
      send("vaultField", {
        kind: info.kind,
        focused,
        rect: look ? look.rect : null,
        formHasPassword: info.formHasPassword,
        maxLength: info.maxLength,
        email: info.email,
        clicked: !!clicked,
        auto: !!focused && vaultFocusAuto,
        rtl: !!look && look.rtl,
        darkField: look ? look.darkField : null,
        brandColor: look ? look.brandColor : null,
        trailingTaken: !!look && look.trailingTaken,
        inset: look ? look.inset : null,
        webauthn: vaultHas(/(^|\s)webauthn(\s|$)/i, vaultAttr(el, "autocomplete") || ""),
        stepUser: focused && info.kind === "password" && vaultStepUser && vaultNow() - vaultStepUser.at < VAULT_STEP_USERNAME_LIFETIME ? vaultStepUser.username : null,
      });
    };
    const vaultBlur = () => {
      const el = vaultFocused;
      const info = vaultFocusedInfo;
      vaultFocused = vaultFocusedInfo = null;
      vaultMenuOpen = vaultMenuHighlighted = false;
      vaultFiltering = null;
      if (el && info) vaultReport(el, info, false);
    };
    const vaultStillFocused = (el) => !!el && vaultIsConnected(el) && !!apply(vaultClosest, el, [":focus"]);
    const vaultFocus = (el, retried) => {
      const info = vaultIsInput(el) ? vaultKindOf(el) : null;
      if (!info) {
        if (!retried && vaultIsInput(el) && vaultInputReadOnly(el))
          apply(vaultNextFrame, window, [vaultGuard(() => vaultStillFocused(el) && !vaultFocused && vaultFocus(el, true))]);
        return;
      }
      if (!vaultLoginPageSent) vaultLookForLogin();
      vaultLastField = el;
      vaultLastInfo = info;
      vaultFocused = el;
      vaultFocusedInfo = info;
      vaultClearedSent = false;
      const chosen = vaultChoseField(el);
      vaultFocusAuto = !chosen;
      vaultReport(el, info, true, chosen);
    };
    const vaultResend = () => {
      vaultRectQueued = false;
      if (vaultFocused && !vaultIsConnected(vaultFocused)) return vaultBlur();
      if (vaultFocused && vaultFocusedInfo) vaultReport(vaultFocused, vaultFocusedInfo, true);
    };
    let vaultWatching = false;
    const vaultWatch = () => {
      if (!vaultMenuOpen || !vaultFocused) {
        vaultWatching = false;
        return;
      }
      if (!vaultIsConnected(vaultFocused)) {
        vaultWatching = false;
        return vaultBlur();
      }
      if (isTop && !vaultSameRect(vaultRect(vaultFocused), vaultSentRect)) vaultReport(vaultFocused, vaultFocusedInfo, true);
      apply(vaultNextFrame, window, [vaultGuard(vaultWatch)]);
    };
    const vaultStartWatch = () => {
      if (vaultWatching || !vaultMenuOpen) return;
      vaultWatching = true;
      apply(vaultNextFrame, window, [vaultGuard(vaultWatch)]);
    };
    const vaultQueueRect = () => {
      if (!isTop || !vaultFocused || vaultRectQueued) return;
      vaultRectQueued = true;
      apply(vaultNextFrame, window, [vaultGuard(vaultResend)]);
    };
    fieldProviders.onMenuMode(
      vaultGuard((on) => {
        if (!vaultFocused || !vaultFocusedInfo) return;
        if (!on) {
          vaultMenuOpen = vaultMenuHighlighted = false;
          return vaultReport(vaultFocused, vaultFocusedInfo, false);
        }
        if (vaultIsConnected(vaultFocused)) vaultReport(vaultFocused, vaultFocusedInfo, true);
      }),
    );

    const VAULT_EMAIL_TEXT = /^[^\s@<>()[\]\\,;:"']{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,24}$/i;
    const VAULT_PLACEHOLDER_EMAIL = /^(name|you|your.?name|your.?email|email|user|username|someone|john.?doe|jane.?doe)@/i;
    const VAULT_NO_TEXT_TAGS = ["script", "style", "template", "noscript", "title", "textarea", "option", "select"];
    const vaultTrimmed = (text) => apply(vaultTrim, VaultText(text || ""), []);
    const vaultFilledValueOf = (el) => vaultTrimmed(vaultValueOf(el));
    const vaultDocumentInputs = () => {
      const root = document.documentElement;
      return root ? vaultInputsIn(root) : [];
    };
    const vaultEmailTextIn = (root) => {
      const all = apply(vaultQuery, root, ["*"]);
      if (all.length > 3000) return "";
      for (let i = 0; i < all.length; i++) {
        const el = all[i];
        if (vaultChildCountOf(el) > 1) continue;
        if (vaultIncludes(VAULT_NO_TEXT_TAGS, vaultLowered(vaultTagOf(el)))) continue;
        const text = vaultTrimmed(vaultTextOf(el, 121));
        if (!text || text.length > 120 || !vaultHas(VAULT_EMAIL_TEXT, text) || vaultHas(VAULT_PLACEHOLDER_EMAIL, text)) continue;
        if (apply(vaultClosest, el, ['a[href^="mailto:"], [aria-hidden="true"]'])) continue;
        return text;
      }
      return "";
    };
    const vaultEmailNear = (scope) => {
      let node = scope && vaultNodeTypeOf(scope) === 1 ? scope : null;
      for (let depth = 0; node && depth <= 3; depth++, node = vaultParentOf(node)) {
        const found = vaultEmailTextIn(node);
        if (found) return found;
      }
      return "";
    };
    const VAULT_STEP_USERNAME_LIFETIME = 600000;
    const VAULT_ACCOUNT_TOKENS = ["username", "email"];
    const vaultUsernameFor = (scope, inputs, fields) => {
      const found = (el, from) => ({ username: vaultFilledValueOf(el), from });
      const inScope = vaultFind(fields, (f) => f.kind === "username" && vaultFilledValueOf(f.el));
      if (inScope) return found(inScope.el, "form");
      const scopeEmail = vaultFind(inputs, (el) => vaultTypeOf(el) === "email" && vaultFilledValueOf(el));
      if (scopeEmail) return found(scopeEmail, "form");
      const everywhere = vaultFilter(vaultDocumentInputs(), (el) => !vaultIsPassword(el));
      const tokened = vaultFind(everywhere, (el) => vaultIncludes(VAULT_ACCOUNT_TOKENS, vaultTokens(vaultAttr(el, "autocomplete"))) && vaultFilledValueOf(el));
      if (tokened) return found(tokened, "page");
      const shownEmail = vaultFind(everywhere, (el) => vaultTypeOf(el) === "email" && vaultUsable(el) && vaultFilledValueOf(el));
      if (shownEmail) return found(shownEmail, "page");
      if (vaultStepUser && vaultNow() - vaultStepUser.at < VAULT_STEP_USERNAME_LIFETIME) return { username: vaultStepUser.username, from: "step" };
      const near = vaultEmailNear(scope);
      return { username: near, from: near ? "nearby" : "" };
    };

    const VAULT_GESTURE_WINDOW = 1000;
    let vaultGesture = null;
    const vaultNoteGesture = (control) => {
      vaultGesture = control ? { control, at: vaultNow() } : null;
    };
    const vaultButtonFormOf = vaultGetterOf(vaultProtoOf("HTMLButtonElement"), "form");
    const vaultOwnerFormOf = (control) => {
      const tag = vaultTagOf(control);
      if (tag === "INPUT") return apply(vaultFormOf, control, []);
      if (tag === "BUTTON") return vaultButtonFormOf(control);
      return null;
    };
    const vaultSubmittedByGesture = (form) => {
      const gesture = vaultGesture;
      if (!gesture || vaultNow() - gesture.at > VAULT_GESTURE_WINDOW) return false;
      const control = gesture.control;
      return vaultOwnerFormOf(control) === form || (!!vaultContains && !!apply(vaultContains, form, [control]));
    };
    const VAULT_FOCUS_WINDOW = 500;
    let vaultTabAt = -Infinity;
    let vaultPressed = null;
    let vaultPressedAt = -Infinity;
    const vaultPressedOn = (el) => {
      if (!vaultPressed || vaultNow() - vaultPressedAt > VAULT_FOCUS_WINDOW) return false;
      if (vaultPressed === el) return true;
      const label = vaultNodeTypeOf(vaultPressed) === 1 ? apply(vaultClosest, vaultPressed, ["label"]) : null;
      return !!label && vaultLabelControlOf(label) === el;
    };
    const vaultSendKey = (key, text) => fieldProviders.menuMode() && send("vaultKey", typeof text === "string" ? { key, text } : { key });
    const vaultChoseField = (el) => vaultNow() - vaultTabAt <= VAULT_FOCUS_WINDOW || vaultPressedOn(el);
    const vaultSubmitFrom = (scope, trusted) => {
      if (!scope || !fieldProviders.menuMode()) return;
      const { inputs, fields } = vaultFieldsIn(scope);
      const secrets = vaultFilter(fields, (f) => (f.kind === "password" || f.kind === "newPassword") && vaultValueOf(f.el) && (vaultTyped.has(f.el) || vaultFilledByUs.has(f.el)));
      if (!secrets.length) {
        const user = vaultFind(fields, (f) => f.kind === "username" && vaultFilledValueOf(f.el));
        if (user && !vaultSome(fields, (f) => f.kind === "password" || f.kind === "newPassword"))
          vaultStepUser = { username: vaultSlice(vaultFilledValueOf(user.el), 0, VAULT_LONGEST_USERNAME), at: vaultNow() };
        return;
      }
      const fresh = vaultFilter(secrets, (f) => f.kind === "newPassword");
      if (fresh.length >= 2 && vaultValueOf(fresh[0].el) !== vaultValueOf(fresh[1].el)) return;
      const chosen = fresh.length ? fresh[0] : secrets[0];
      const password = vaultValueOf(chosen.el);
      const who = vaultUsernameFor(scope, inputs, fields);
      const username = vaultSlice(who.username, 0, VAULT_LONGEST_USERNAME);
      const usernameFrom = username ? who.from : "";
      const isTrusted = trusted === true;
      const now = vaultNow();
      const last = vaultLastSubmit;
      if (last && last.username === username && last.length === password.length && now - last.at < 1000 && (last.trusted || !isTrusted)) return;
      vaultLastSubmit = { username, length: password.length, at: now, trusted: isTrusted };
      send("vaultSubmit", { username, password, newPassword: chosen.kind === "newPassword", usernameFrom, trusted: isTrusted });
      vaultWatchLogin(chosen.el, username);
    };
    const VAULT_OUTCOME_STEP = 250;
    const VAULT_OUTCOME_WAIT = 5000;
    let vaultLogin = null;
    const vaultLoginLeft = (login) => !vaultIsConnected(login.field) || !vaultUsable(login.field) || location.href !== login.href;
    const vaultReportLogin = (login, ok) => {
      if (vaultLogin !== login) return;
      vaultLogin = null;
      if (fieldProviders.menuMode()) send("vaultLoginOutcome", { ok });
    };
    const vaultCheckLogin = (login) => {
      if (vaultLogin !== login) return;
      if (vaultLoginLeft(login)) return vaultReportLogin(login, true);
      if (vaultNow() - login.at >= VAULT_OUTCOME_WAIT) return vaultReportLogin(login, false);
      vaultLater(() => vaultCheckLogin(login), VAULT_OUTCOME_STEP);
    };
    const vaultWatchLogin = (field, username) => {
      const login = { field, username, href: location.href, at: vaultNow() };
      vaultLogin = login;
      vaultLater(() => vaultCheckLogin(login), VAULT_OUTCOME_STEP);
    };
    const vaultLeaveLogin = () => {
      const login = vaultLogin;
      if (!login) return;
      vaultLogin = null;
      if (fieldProviders.menuMode()) send("vaultLoginOutcome", { left: true, username: login.username });
    };
    const VAULT_LANDING_LOOK_AGAIN = 1500;
    let vaultLoaded = document.readyState === "complete";
    const vaultSameUsername = (a, b) => apply(vaultLower, vaultTrimmed(a), []) === apply(vaultLower, vaultTrimmed(b), []);
    const vaultLoginShownAgain = (username) => {
      const inputs = vaultFilter(vaultDocumentInputs(), (el) => vaultIsPassword(el) && vaultUsable(el));
      for (let i = 0; i < inputs.length; i++) {
        const { fields } = vaultFieldsIn(vaultContainerOf(inputs[i]));
        if (!vaultSome(fields, (f) => f.el === inputs[i] && f.kind === "password")) continue;
        const user = vaultFind(fields, (f) => f.kind === "username" && vaultFilledValueOf(f.el));
        if (!user || !username || vaultSameUsername(vaultFilledValueOf(user.el), username)) return true;
      }
      return false;
    };
    const vaultCheckLanding = (username, last) => {
      const failed = vaultLoginShownAgain(username);
      if (!failed && !last) return vaultLater(() => vaultCheckLanding(username, true), VAULT_LANDING_LOOK_AGAIN);
      if (fieldProviders.menuMode()) send("vaultLoginOutcome", { checked: true, ok: !failed });
    };
    handlers.vaultLoginCheck = vaultInOnePass((message) => {
      const username = message && typeof message.username === "string" ? message.username : "";
      if (vaultLoaded) return vaultLater(() => vaultCheckLanding(username, false), 0);
      apply(vaultListen, window, ["load", vaultGuard(() => vaultLater(() => vaultCheckLanding(username, false), 0)), { once: true }]);
    });
    const VAULT_SUBMIT_TEXT = /log.?in|sign.?in|sign.?up|continue|next|submit|register|create|save|enter|\bgo\b|\bok\b|weiter|anmelden|connexion|iniciar|entrar|accedi/;
    const VAULT_NOT_SUBMIT = /forgot|reset|google|apple|facebook|microsoft|github|twitter|passkey|\bsso\b|cancel|\bback\b|show|hide|reveal|another|different|help/;
    const VAULT_SIGNUP_TEXT = /sign.?up|regist|create|join/;
    const VAULT_CONTROLS = 'button, input[type="submit"], input[type="image"], [role="button"]';
    const VAULT_SUBMIT_TYPES = ["submit", "image"];
    const vaultButtonTextOf = (button) => vaultLowered(vaultTextOf(button, 60) + " " + vaultAttr(button, "value") + " " + vaultAttr(button, "aria-label"));
    const vaultButtonType = vaultGetterOf(vaultProtoOf("HTMLButtonElement"), "type");
    const vaultButtonTypeOf = (button) => {
      const tag = vaultTagOf(button);
      if (tag === "INPUT") return vaultTypeOf(button);
      if (tag === "BUTTON") return vaultLowered(vaultButtonType(button) || vaultAttr(button, "type") || "submit");
      return vaultLowered(vaultAttr(button, "type"));
    };
    const vaultSubmitButtonOf = (el) => {
      const button = el && vaultNodeTypeOf(el) === 1 ? apply(vaultClosest, el, [VAULT_CONTROLS]) : null;
      if (!button) return null;
      const type = vaultButtonTypeOf(button);
      if ((type === "submit" || type === "image") && apply(vaultClosest, button, ["form"])) return button;
      return vaultHas(VAULT_SUBMIT_TEXT, vaultButtonTextOf(button)) ? button : null;
    };
    const vaultSubmitControlIn = (scope, lastFilled, login) => {
      const ordered = vaultNodes(scope, vaultQuery, 'input, button, [role="button"]');
      const lastAt = vaultIndexOf(ordered, lastFilled);
      const controls = vaultFilter(vaultNodes(scope, vaultQuery, VAULT_CONTROLS), (b) => {
        if (vaultDisabled(b) || vaultAttr(b, "aria-disabled") === "true" || vaultHidden(b)) return false;
        const text = vaultButtonTextOf(b);
        return !vaultHas(VAULT_NOT_SUBMIT, text) && !(login && vaultHas(VAULT_SIGNUP_TEXT, text));
      });
      const typed = (b) => vaultIncludes(VAULT_SUBMIT_TYPES, vaultButtonTypeOf(b)) && !!apply(vaultClosest, b, ["form"]);
      const fits = (b) => typed(b) || vaultHas(VAULT_SUBMIT_TEXT, vaultButtonTextOf(b));
      const positionOf = (b) => vaultIndexOf(ordered, b);
      const after = vaultSorted(vaultFilter(controls, (b) => positionOf(b) > lastAt), (a, b) => positionOf(a) - positionOf(b));
      const before = vaultSorted(vaultFilter(controls, (b) => positionOf(b) < lastAt && typed(b)), (a, b) => positionOf(b) - positionOf(a));
      return vaultFind(after, typed) || vaultFind(after, fits) || before[0] || null;
    };

    const VAULT_TINT_LIGHT = "rgba(250, 220, 90, 0.35)";
    const VAULT_TINT_DARK = "rgba(250, 220, 90, 0.22)";
    const VAULT_TINT_HOLD = 600;
    const VAULT_TINT_FADE = 900;
    const VAULT_TRANSITION_PARTS = ["transition-property", "transition-duration", "transition-timing-function", "transition-delay"];
    const VAULT_TINTED_PARTS = ["background-color", ...VAULT_TRANSITION_PARTS];
    const vaultTints = vaultTable();
    const vaultPrefers = (query) => {
      try {
        const list = vaultMedia ? apply(vaultMedia, window, [query]) : null;
        return !!(list && list.matches);
      } catch (e) {
        return false;
      }
    };
    const vaultDarkScheme = (el) => {
      const style = apply(vaultStyleOf, window, [el]);
      const scheme = vaultLowered(style && style.colorScheme);
      if (!vaultHas(/dark/, scheme)) return false;
      return !vaultHas(/light/, scheme) || vaultPrefers("(prefers-color-scheme: dark)");
    };
    const vaultInlineOf = (el) => (vaultInlineStyleOf ? apply(vaultInlineStyleOf, el, []) : el.style);
    const vaultReadStyle = (style, name) => ({ value: apply(vaultCSSValue, style, [name]), priority: apply(vaultCSSPriority, style, [name]) });
    const vaultWriteStyle = (style, name, saved) =>
      saved.value ? apply(vaultCSSSet, style, [name, saved.value, saved.priority]) : apply(vaultCSSRemove, style, [name]);
    const vaultSetOurStyle = (tint, name, value) => {
      apply(vaultCSSSet, tint.style, [name, value, "important"]);
      tint.ours[name] = apply(vaultCSSValue, tint.style, [name]);
    };
    const vaultRestoreStyle = (tint, name) => {
      if (!(name in tint.ours)) return;
      if (apply(vaultCSSValue, tint.style, [name]) === tint.ours[name]) vaultWriteStyle(tint.style, name, tint.saved[name]);
      delete tint.ours[name];
    };
    const vaultUntint = (el) => {
      const tint = vaultTints.get(el);
      if (!tint) return;
      vaultTints.delete(el);
      for (let i = 0; i < tint.timers.length; i++) apply(vaultClearTimer, window, [tint.timers[i]]);
      vaultRestoreStyle(tint, "background-color");
      for (let i = 0; i < VAULT_TRANSITION_PARTS.length; i++) vaultRestoreStyle(tint, VAULT_TRANSITION_PARTS[i]);
    };
    const vaultLater = (fn, ms) => apply(vaultTimer, window, [vaultGuard(fn), ms]);
    const vaultTint = (el) => {
      vaultUntint(el);
      const style = vaultInlineOf(el);
      if (!style) return;
      const saved = {};
      for (let i = 0; i < VAULT_TINTED_PARTS.length; i++) saved[VAULT_TINTED_PARTS[i]] = vaultReadStyle(style, VAULT_TINTED_PARTS[i]);
      const tint = { style, saved, ours: {}, timers: vaultList() };
      vaultTints.set(el, tint);
      const reduced = vaultPrefers("(prefers-reduced-motion: reduce)");
      vaultSetOurStyle(tint, "transition-property", "none");
      vaultSetOurStyle(tint, "background-color", vaultDarkScheme(el) ? VAULT_TINT_DARK : VAULT_TINT_LIGHT);
      if (reduced) {
        vaultAdd(tint.timers, vaultLater(() => vaultUntint(el), VAULT_TINT_FADE));
        return;
      }
      vaultAdd(
        tint.timers,
        vaultLater(() => {
          if (vaultTints.get(el) !== tint) return;
          vaultSetOurStyle(tint, "transition-property", "background-color");
          vaultSetOurStyle(tint, "transition-duration", VAULT_TINT_FADE + "ms");
          vaultSetOurStyle(tint, "transition-timing-function", "ease-out");
          vaultSetOurStyle(tint, "transition-delay", "0s");
          vaultRestoreStyle(tint, "background-color");
          vaultAdd(tint.timers, vaultLater(() => vaultTints.get(el) === tint && vaultUntint(el), VAULT_TINT_FADE + 50));
        }, VAULT_TINT_HOLD),
      );
    };

    const vaultOptions = { capture: true };
    const VAULT_MENU_KEYS = ["ArrowDown", "ArrowUp", "Enter", "Escape", "Tab"];
    apply(vaultListen, document, [
      "focusin",
      vaultGuard((e) => {
        if (!e.isTrusted) return;
        const el = vaultTargetOf(e);
        if (el === vaultFocused) {
          const info = vaultKindOf(el);
          if (!info) return vaultBlur();
          vaultFocusedInfo = vaultLastInfo = info;
          return vaultReport(el, info, true);
        }
        if (vaultFocused) vaultBlur();
        vaultFocus(el);
      }),
      vaultOptions,
    ]);
    apply(vaultListen, document, [
      "focusout",
      vaultGuard((e) => {
        if (vaultFocused && vaultTargetOf(e) === vaultFocused) vaultBlur();
      }),
      vaultOptions,
    ]);
    apply(vaultListen, document, [
      "mousedown",
      vaultGuard((e) => {
        if (!e.isTrusted) return;
        const el = vaultTargetOf(e);
        vaultPressed = el;
        vaultPressedAt = vaultNow();
        if (!vaultFocused && vaultIsInput(el) && vaultStillFocused(el)) vaultFocus(el);
        if (vaultFocused && el === vaultFocused) {
          vaultFocusAuto = false;
          vaultReport(vaultFocused, vaultFocusedInfo, true, true);
        }
      }),
      vaultOptions,
    ]);
    apply(vaultListen, document, [
      "input",
      vaultGuard((e) => {
        const el = vaultTargetOf(e);
        if (!vaultIsInput(el)) return;
        const empty = !vaultValueOf(el);
        const typedBefore = vaultTyped.has(el);
        if (empty) {
          vaultTyped.delete(el);
          vaultFilledByUs.delete(el);
        } else if (e.isTrusted) vaultTyped.add(el);
        if (!e.isTrusted) return;
        vaultUntint(el);
        if (el !== vaultFocused) return;
        if (vaultIsPassword(el) && empty === typedBefore) vaultQueueRect();
        if (empty) {
          if (!vaultClearedSent) vaultSendKey("Cleared");
          vaultClearedSent = true;
          return;
        }
        vaultClearedSent = false;
        const filters = vaultFocusedInfo && vaultFocusedInfo.kind === "username" && (vaultMenuOpen || vaultFiltering === el);
        if (filters) {
          vaultFiltering = el;
          vaultSendKey("Typed", vaultSlice(vaultValueOf(el), 0, VAULT_LONGEST_TYPED));
          return;
        }
        if (vaultMenuOpen) {
          vaultMenuOpen = vaultMenuHighlighted = false;
          vaultSendKey("Typed");
        }
      }),
      vaultOptions,
    ]);
    apply(vaultListen, document, [
      "submit",
      vaultGuard((e) => {
        const form = vaultTargetOf(e);
        if (form && vaultNodeTypeOf(form) === 1) vaultSubmitFrom(form, vaultSubmittedByGesture(form));
      }),
      vaultOptions,
    ]);
    apply(vaultListen, document, [
      "click",
      vaultGuard((e) => {
        if (!e.isTrusted) return;
        const button = vaultSubmitButtonOf(vaultTargetOf(e));
        vaultNoteGesture(button);
        if (button) vaultSubmitFrom(vaultContainerOf(button), true);
      }),
      vaultOptions,
    ]);
    apply(vaultListen, window, [
      "keydown",
      vaultGuard((e) => {
        if (!e.isTrusted) return;
        const el = vaultTargetOf(e);
        const key = vaultKeyOf(e);
        const alt = vaultAltOf(e);
        const ctrl = vaultCtrlOf(e);
        const meta = vaultMetaOf(e);
        if (key === "Enter") vaultNoteGesture(vaultIsInput(el) ? el : null);
        if (key === "Tab" && !alt && !ctrl && !meta) vaultTabAt = vaultNow();
        if (vaultMenuOpen && vaultFocused && el === vaultFocused && vaultIncludes(VAULT_MENU_KEYS, key)) {
          const passesToPage = key === "Tab" || (key === "Enter" && !vaultMenuHighlighted);
          if (!passesToPage) {
            apply(vaultPrevent, e, []);
            apply(vaultStopNow, e, []);
          }
          if (passesToPage || key === "Escape") {
            vaultMenuOpen = vaultMenuHighlighted = false;
            vaultFiltering = null;
          }
          vaultSendKey(key);
          if (key !== "Enter" || !passesToPage) return;
        }
        if (!vaultMenuOpen && vaultFocused && el === vaultFocused && key === "ArrowDown" && !alt && !ctrl && !meta && !vaultShiftOf(e)) {
          vaultSendKey("ArrowDown");
          return;
        }
        if (key === "Enter" && vaultIsInput(el)) vaultSubmitFrom(vaultContainerOf(el), true);
      }),
      vaultOptions,
    ]);
    apply(vaultListen, window, ["scroll", vaultQueueRect, { capture: true, passive: true }]);
    apply(vaultListen, window, ["resize", vaultQueueRect]);
    if (vaultViewport) {
      apply(vaultListen, vaultViewport, ["resize", vaultQueueRect]);
      apply(vaultListen, vaultViewport, ["scroll", vaultQueueRect, { passive: true }]);
    }
    apply(vaultListen, window, ["pagehide", vaultGuard(vaultBlur)]);
    apply(vaultListen, window, ["pagehide", vaultGuard(vaultLeaveLogin)]);
    apply(vaultListen, window, ["load", vaultGuard(() => (vaultLoaded = true)), { once: true }]);
    apply(vaultListen, window, [
      "pageshow",
      vaultGuard((e) => {
        if (!e.persisted) return;
        const el = vaultFocused || vaultLastField;
        vaultFocused = vaultFocusedInfo = null;
        vaultMenuOpen = vaultMenuHighlighted = false;
        if (vaultStillFocused(el)) vaultFocus(el);
      }),
    ]);

    const VAULT_LOGIN_LOOK_AGAIN = 1500;
    const VAULT_LOGIN_TOKENS = ["username", "current-password", "one-time-code"];
    let vaultLoginPageSent = false;
    const vaultLooksLikeLogin = (el) => (vaultIsPassword(el) || vaultIncludes(VAULT_LOGIN_TOKENS, vaultTokens(vaultAttr(el, "autocomplete")))) && vaultUsable(el);
    const vaultLookForLogin = () => {
      if (vaultLoginPageSent || !fieldProviders.menuMode() || !vaultSome(vaultDocumentInputs(), vaultLooksLikeLogin)) return;
      vaultLoginPageSent = true;
      send("vaultLoginPage", {});
    };
    const vaultLookSoon = () => {
      vaultLater(vaultLookForLogin, 0);
      vaultLater(vaultLookForLogin, VAULT_LOGIN_LOOK_AGAIN);
    };
    if (document.readyState === "complete") vaultLookSoon();
    else apply(vaultListen, window, ["load", vaultGuard(vaultLookSoon), { once: true }]);

    const vaultPut = (el, value) => {
      apply(vaultSetValue, el, [value]);
      vaultFilledByUs.add(el);
      apply(vaultDispatch, el, [new VaultInputEvent("input", { bubbles: true, composed: true, inputType: "insertReplacementText", data: value })]);
      apply(vaultDispatch, el, [new VaultEvent("change", { bubbles: true, composed: true })]);
    };
    const vaultPutText = (el, value) => {
      if (vaultIsTextArea(el)) {
        apply(vaultTextAreaValue.set, el, [value]);
      } else {
        apply(vaultFocusOn, el, []);
        if (!vaultExecCommand || !apply(vaultExecCommand, document, ["insertText", false, value])) return false;
      }
      vaultFilledByUs.add(el);
      if (vaultIsTextArea(el)) apply(vaultDispatch, el, [new VaultInputEvent("input", { bubbles: true, composed: true, inputType: "insertReplacementText", data: value })]);
      apply(vaultDispatch, el, [new VaultEvent("change", { bubbles: true, composed: true })]);
      return true;
    };
    const vaultSpread = (run, value, steps, touched) => {
      for (let i = 0; i < value.length; i++) {
        vaultAdd(steps, { el: run[i], value: value[i] });
        vaultAddOnce(touched, run[i]);
      }
    };
    const vaultFill = (message, anchor = vaultLastField, anchorInfo = vaultLastInfo) => {
      if (!message || typeof message.origin !== "string" || message.origin !== vaultOrigin()) return null;
      if (!anchor || !vaultIsConnected(anchor) || !vaultUsable(anchor)) return null;
      const scope = vaultContainerOf(anchor);
      const { inputs, fields } = vaultFieldsIn(scope);
      if (!vaultIncludes(inputs, anchor)) return null;
      const anchorField = vaultFind(fields, (f) => f.el === anchor);
      const anchorKind = anchorField ? anchorField.kind : null;
      const passwords = vaultFilter(inputs, vaultIsPassword);
      const ofKind = (kind) => vaultMap(vaultFilter(fields, (f) => f.kind === kind), (f) => f.el);
      const filled = vaultList();
      const touched = vaultList();
      const put = (el, value, name) => {
        vaultPut(el, value);
        vaultAddOnce(touched, el);
        vaultAddOnce(filled, name);
      };
      if (vaultFillable(message.username)) {
        const users = ofKind("username");
        const target = anchorKind === "username" ? anchor : vaultFind(users, (el) => !passwords.length || vaultIndexOf(inputs, el) < vaultIndexOf(inputs, passwords[0])) || users[0];
        if (target) put(target, message.username, "username");
      }
      if (vaultFillable(message.password)) {
        const current = ofKind("password");
        const target = anchorKind === "password" ? anchor : current[0] || (passwords.length === 1 ? passwords[0] : null);
        if (target) put(target, message.password, "password");
      }
      if (vaultFillable(message.newPassword)) {
        const fresh = ofKind("newPassword");
        const fromAnchor = anchorKind === "password" && !vaultIncludes(fresh, anchor);
        const after = vaultFilter(fresh, (el) => vaultIndexOf(inputs, el) > vaultIndexOf(inputs, anchor));
        const targets = fromAnchor ? vaultFrom(after, 0) : fresh.length ? fresh : passwords.length === 1 ? passwords : vaultList();
        if (fromAnchor) put(anchor, message.newPassword, "newPassword");
        for (let i = 0; i < targets.length; i++) put(targets[i], message.newPassword, "newPassword");
      }
      const steps = vaultList();
      if (vaultFillable(message.otp)) {
        const codeAnchor = anchorKind === "otp" || (!anchorKind && !!anchorInfo && anchorInfo.kind === "otp");
        const run = codeAnchor ? vaultSplitRunOf(anchor) : null;
        if (run && message.otp.length <= run.length) {
          vaultSpread(run, message.otp, steps, touched);
          vaultAddOnce(filled, "otp");
        } else {
          const target = codeAnchor ? anchor : ofKind("otp")[0];
          if (target) put(target, message.otp, "otp");
        }
      }
      vaultSorted(touched, (a, b) => vaultIndexOf(inputs, a) - vaultIndexOf(inputs, b));
      return { filled, touched, scope, anchor, inputs, steps, origin: message.origin };
    };
    const vaultFocusAfter = (fill) => {
      const { touched, inputs, scope } = fill;
      if (!touched.length) return;
      const last = vaultIndexOf(inputs, touched[touched.length - 1]);
      const next = vaultFind(vaultFrom(inputs, last + 1), (el) => vaultIncludes(VAULT_TEXT_TYPES, vaultTypeOf(el)) && !vaultValueOf(el));
      const submit = next ? null : vaultFind(vaultNodes(scope, vaultQuery, 'button, input[type="submit"]'), (b) => vaultButtonTypeOf(b) === "submit" && !vaultHidden(b));
      const focusTarget = next || submit;
      if (focusTarget) apply(vaultFocusOn, focusTarget, []);
    };
    const vaultRunSteps = (fill, done) => {
      const step = fill.steps[fill.step || 0];
      fill.step = (fill.step || 0) + 1;
      if (!step) return done();
      if (vaultOrigin() !== fill.origin || !vaultIsConnected(step.el)) {
        fill.steps = vaultList();
        fill.filled = vaultList();
        fill.touched = vaultList();
        return done();
      }
      apply(vaultFocusOn, step.el, []);
      vaultLater(() => {
        vaultPut(step.el, step.value);
        vaultRunSteps(fill, done);
      }, 0);
    };

    const VAULT_SUBMIT_DELAY = 60;
    const VAULT_REMEMBERED_FILLS = 32;
    const vaultSubmittedFills = vaultList();
    const vaultBlocksSubmit = (el, inputs) => {
      if (vaultInputDisabled(el) || vaultTypeOf(el) === "hidden") return false;
      if (apply(vaultAttrOf, el, ["required"]) === null && vaultAttr(el, "aria-required") !== "true") return false;
      const type = vaultTypeOf(el);
      if (type === "checkbox") return !apply(vaultCheckedOf, el, []);
      if (type === "radio") {
        const name = vaultAttr(el, "name");
        return !vaultSome(inputs, (other) => vaultTypeOf(other) === "radio" && (other === el || (name && vaultAttr(other, "name") === name)) && apply(vaultCheckedOf, other, []));
      }
      return vaultIncludes(VAULT_EDITABLE_TYPES, type) && !vaultHidden(el) && !vaultValueOf(el);
    };
    const VAULT_ENTER_STEPS = ["keydown", "keypress", "keyup"];
    const VAULT_KEY_CODES = ["keyCode", "which", "charCode"];
    const vaultPressEnter = (el) => {
      let proceed = true;
      for (let i = 0; i < VAULT_ENTER_STEPS.length; i++) {
        const type = VAULT_ENTER_STEPS[i];
        if (type === "keypress" && !proceed) continue;
        const code = type === "keypress" ? 13 : 0;
        const init = { key: "Enter", code: "Enter", keyCode: 13, which: 13, charCode: code, bubbles: true, cancelable: true, composed: true };
        const event = new VaultKeyboardEvent(type, init);
        for (let j = 0; j < VAULT_KEY_CODES.length; j++) {
          const name = VAULT_KEY_CODES[j];
          if (event[name] === init[name]) continue;
          try {
            vaultDefine(event, name, { value: init[name], configurable: true });
          } catch (e) {}
        }
        const result = apply(vaultDispatch, el, [event]);
        if (type === "keydown") proceed = result !== false;
      }
    };
    const vaultAutoSubmit = (fill) => {
      const { scope, origin, touched } = fill;
      if (vaultOrigin() !== origin || !vaultIsConnected(scope)) return;
      const inputs = vaultInputsIn(scope);
      const shown = vaultFilter(inputs, vaultUsable);
      const kept = vaultFilter(touched, (el) => vaultIsConnected(el) && vaultValueOf(el));
      if (!kept.length) return;
      if (vaultSome(shown, (el) => vaultIsPassword(el) && !vaultValueOf(el))) return;
      if (vaultSome(inputs, (el) => vaultBlocksSubmit(el, inputs))) return;
      const anchor = vaultIsConnected(fill.anchor) ? fill.anchor : kept[kept.length - 1];
      const lastFilled = kept[kept.length - 1];
      const login = !vaultIncludes(fill.filled, "newPassword") && (vaultIncludes(fill.filled, "password") || vaultIncludes(fill.filled, "username"));
      const button = vaultSubmitControlIn(scope, lastFilled, login);
      const form = apply(vaultFormOf, anchor, []);
      vaultSubmitFrom(scope, true);
      if (button) return apply(vaultClick, button, []);
      if (form) {
        if (typeof vaultRequestSubmit === "function") return apply(vaultRequestSubmit, form, []);
        return apply(vaultDispatch, form, [new VaultEvent("submit", { bubbles: true, cancelable: true })]);
      }
      vaultPressEnter(lastFilled);
    };
    const vaultQueueSubmit = (id, fill) => {
      if (vaultIncludes(vaultSubmittedFills, id)) return;
      vaultAdd(vaultSubmittedFills, id);
      if (vaultSubmittedFills.length > VAULT_REMEMBERED_FILLS) {
        for (let i = 1; i < vaultSubmittedFills.length; i++) vaultSubmittedFills[i - 1] = vaultSubmittedFills[i];
        vaultSubmittedFills.length--;
      }
      vaultLater(() => vaultAutoSubmit(fill), VAULT_SUBMIT_DELAY);
    };
    const vaultFinishFill = (message, id, fill) => {
      try {
        if (fill) vaultFocusAfter(fill);
      } catch (e) {}
      send("vaultFilled", { id, filled: fill ? fill.filled : [] });
      if (!fill || !fill.touched.length) return;
      for (let i = 0; i < fill.touched.length; i++) vaultGuard(vaultTint)(fill.touched[i]);
      if (message.submit === true && id) vaultQueueSubmit(id, fill);
    };
    handlers.vaultFill = vaultInOnePass((message) => {
      let fill = null;
      try {
        fill = message && message.context === true ? vaultFillContext(message) : vaultFill(message);
      } catch (e) {}
      const id = message && typeof message.id === "string" ? message.id : "";
      if (fill && fill.steps.length) return vaultRunSteps(fill, () => vaultFinishFill(message, id, fill));
      vaultFinishFill(message, id, fill);
    });
    handlers.vaultMenu = vaultInOnePass((message) => {
      const open = !!(message && message.open === true);
      if (open && !vaultFocused && vaultStillFocused(vaultLastField)) vaultFocus(vaultLastField);
      vaultMenuOpen = open && !!vaultFocused;
      vaultMenuHighlighted = vaultMenuOpen && message.highlighted === true;
      if (open && !vaultMenuOpen && vaultLastField && vaultLastInfo) vaultReport(vaultLastField, vaultLastInfo, false);
      vaultStartWatch();
    });

    const VAULT_CONTEXT_VALUES = ["username", "password", "newPassword", "otp"];
    const VAULT_CONTEXT_TYPES = ["text", "email", "tel", "url", "password", "search", ""];
    const vaultTextAreaProto = vaultProtoOf("HTMLTextAreaElement");
    const VaultTextAreaElement = vaultTextAreaProto ? globalThis.HTMLTextAreaElement : null;
    const vaultTextAreaValue = vaultTextAreaProto ? Object.getOwnPropertyDescriptor(vaultTextAreaProto, "value") : null;
    const vaultTextAreaReadOnly = vaultGetterOf(vaultTextAreaProto, "readOnly");
    const vaultEditable = vaultGetterOf(vaultProtoOf("HTMLElement"), "isContentEditable");
    const vaultExecCommand = typeof document.execCommand === "function" ? document.execCommand : null;
    const vaultIsTextArea = (el) => !!VaultTextAreaElement && !!el && typeof el === "object" && apply(vaultHasInstance, VaultTextAreaElement, [el]);
    const vaultIsEditableText = (el) => !!el && typeof el === "object" && !vaultIsInput(el) && !vaultIsTextArea(el) && apply(vaultHasInstance, HTMLElement, [el]) && vaultEditable(el) === true;
    let vaultContextField = null;
    const vaultContextUsable = (el) => {
      if (vaultIsInput(el)) return vaultUsable(el) && vaultIncludes(VAULT_CONTEXT_TYPES, vaultTypeOf(el));
      if (vaultIsTextArea(el)) return !vaultTextAreaReadOnly(el) && !vaultHidden(el);
      return vaultIsEditableText(el) && !vaultHidden(el);
    };
    const vaultContextGuess = (el, info) => {
      if (info) return info.kind === "newPassword" ? "password" : info.kind;
      if (vaultIsPassword(el)) return "password";
      return vaultTokens(vaultAttr(el, "autocomplete")) === "one-time-code" ? "otp" : "username";
    };
    apply(vaultListen, window, [
      "contextmenu",
      vaultGuard((e) => {
        if (!e.isTrusted) return;
        const el = vaultTargetOf(e);
        if (!vaultContextUsable(el)) {
          vaultContextField = null;
          return send("vaultContext", { field: false });
        }
        const info = vaultIsInput(el) ? vaultKindOf(el) : null;
        const maxLength = vaultIsInput(el) ? apply(vaultMaxLengthOf, el, []) : 0;
        vaultContextField = el;
        send("vaultContext", {
          field: true,
          kind: info ? info.kind : null,
          guess: vaultContextGuess(el, info),
          rect: vaultRect(el),
          maxLength: typeof maxLength === "number" && maxLength > 0 ? maxLength : 0,
        });
      }),
      vaultOptions,
    ]);
    const vaultFillContext = (message) => {
      const el = vaultContextField;
      if (!message || typeof message.origin !== "string" || message.origin !== vaultOrigin()) return null;
      message.submit = false;
      if (!el || !vaultIsConnected(el) || !vaultContextUsable(el)) return null;
      const names = vaultFilter(VAULT_CONTEXT_VALUES, (name) => vaultFillable(message[name]));
      if (!names.length) return null;
      const name = names[0];
      const input = vaultIsInput(el);
      if (input && (names.length > 1 || (name === "newPassword" && vaultIsPassword(el)))) return vaultFill(message, el, vaultKindOf(el));
      const value = message[name];
      const fill = { filled: vaultAdd(vaultList(), name), touched: vaultList(), scope: el, anchor: el, inputs: vaultAdd(vaultList(), el), steps: vaultList(), origin: message.origin };
      if (!input) {
        if (!vaultPutText(el, value)) return null;
        vaultAdd(fill.touched, el);
        return fill;
      }
      const run = name === "otp" ? vaultSplitRunOf(el) : null;
      if (run && value.length <= run.length) {
        fill.inputs = run;
        vaultSpread(run, value, fill.steps, fill.touched);
        return fill;
      }
      vaultPut(el, value);
      vaultAdd(fill.touched, el);
      return fill;
    };

    const vaultSelectionOf = window.getSelection;
    const vaultUpper = String.prototype.toUpperCase;
    const VAULT_CODE_KEY = /^[a-z2-7]{2,32}(?:[ -][a-z2-7]{2,32})*$/i;
    const VAULT_CODE_LONGEST_TEXT = 2048;
    const VAULT_CODE_PARENTS = 3;
    const vaultCodeKeyOf = (text) => {
      const trimmed = vaultTrimmed(text);
      if (trimmed.length < 16 || trimmed.length > VAULT_CODE_LONGEST_TEXT) return "";
      if (fieldProviders.verificationSetupURL(trimmed)) return trimmed;
      if (trimmed.length > 160 || !vaultHas(VAULT_CODE_KEY, trimmed)) return "";
      const groups = apply(vaultSplit, trimmed, [/[ -]/]);
      let compact = "";
      for (let i = 0; i < groups.length; i++) {
        if (i < groups.length - 1 && groups[i].length !== groups[0].length) return "";
        if (i === groups.length - 1 && groups.length > 1 && groups[i].length > groups[0].length) return "";
        compact += groups[i];
      }
      if (compact.length < 16 || compact.length > 128) return "";
      const shouted = compact === apply(vaultUpper, compact, []);
      return shouted || vaultHas(/[2-7]/, compact) ? trimmed : "";
    };
    const vaultCodeSelection = (el) => {
      if (vaultIsInput(el)) {
        const value = vaultValueOf(el);
        const from = vaultSelectionStartOf(el);
        const to = vaultSelectionEndOf(el);
        if (typeof from === "number" && typeof to === "number" && to > from) return vaultSlice(value, from, to);
        return vaultInputReadOnly(el) ? value : "";
      }
      if (typeof vaultSelectionOf !== "function") return "";
      const selection = apply(vaultSelectionOf, window, []);
      return selection ? VaultText(selection) : "";
    };
    const vaultCodeImageOf = (el) => {
      const svg = apply(vaultClosest, el, ["svg"]);
      if (svg) return svg;
      for (let n = el, depth = 0; n && depth <= VAULT_CODE_PARENTS; n = vaultParentOf(n), depth++) {
        const tag = apply(vaultUpper, VaultText(vaultTagOf(n) || ""), []);
        if (tag === "IMG" || tag === "CANVAS" || tag === "PICTURE" || tag === "OBJECT" || tag === "EMBED") return n;
        const style = apply(vaultStyleOf, window, [n]);
        const background = style && style.backgroundImage;
        if (typeof background === "string" && vaultHas(/url\(/i, background)) return n;
      }
      return null;
    };
    const vaultCodeLinkOf = (el) => {
      const link = apply(vaultClosest, el, ["a[href]"]);
      const href = link ? vaultAttr(link, "href") : "";
      return fieldProviders.verificationSetupURL(vaultTrimmed(href)) || "";
    };
    apply(vaultListen, window, [
      "contextmenu",
      vaultGuard((e) => {
        if (!e.isTrusted) return;
        let el = vaultTargetOf(e);
        if (el && vaultNodeTypeOf(el) !== 1) el = vaultParentOf(el);
        if (!el || vaultNodeTypeOf(el) !== 1) return send("vaultCodeTarget", {});
        const text = vaultCodeKeyOf(vaultCodeSelection(el)) || vaultCodeKeyOf(vaultCodeLinkOf(el));
        if (text) return send("vaultCodeTarget", { text, rect: vaultRect(el) });
        const image = vaultIsInput(el) ? null : vaultCodeImageOf(el);
        if (!image) return send("vaultCodeTarget", {});
        const rect = vaultRect(image);
        const viewport = rect ? { width: vaultViewWidth(), height: vaultViewHeight() } : null;
        send("vaultCodeTarget", { image: true, rect, viewport });
      }),
      vaultOptions,
    ]);
  } catch (e) {}

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
    let sent = false;
    const painted = (loaded) => {
      if (sent) return;
      sent = true;
      send("firstPaint", { url: location.href, loaded: !!loaded });
    };
    const afterFrames = () => apply(raf, window, [() => apply(raf, window, [() => painted(true)])]);
    if (document.readyState === "complete") afterFrames();
    else apply(listen, window, ["load", afterFrames, { once: true }]);
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
      onReady(() => apply(raf, window, [() => painted(true)]));
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
    const activated = () => {
      const activation = apply(userActivationOf.get, navigator, []);
      return !!activation && !!apply(activeOf.get, activation, []);
    };
    const tracksActivation = !!(userActivationOf && activeOf);
    const clickDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "click");
    if (tracksActivation && clickDescriptor && typeof clickDescriptor.value === "function") {
      const watchScriptedLinkClick = guard((link) => {
        if (linkUrl(link) === null || !activated()) return null;
        let dispatched = null;
        const seen = (e) => {
          if (!dispatched) dispatched = e;
        };
        apply(listen, link, ["click", seen, true]);
        return guard(() => {
          apply(unlisten, link, ["click", seen, true]);
          if (!dispatched || defaultPrevented(dispatched) || replacesPage(link)) return;
          const url = linkUrl(link);
          if (peekable({ link, url, path: [link] })) send("newTabLink", { url });
        });
      });
      const click = asNative(clickDescriptor.value, (target, self, args) => {
        const settle = watchScriptedLinkClick(self);
        try {
          return apply(target, self, args);
        } finally {
          if (settle) settle();
        }
      });
      Object.defineProperty(HTMLElement.prototype, "click", { ...clickDescriptor, value: click });
    }
    const openDescriptor = Object.getOwnPropertyDescriptor(window, "open");
    if (tracksActivation && openDescriptor && typeof openDescriptor.value === "function") {
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
      const MEDIA_ERR_ENCRYPTED = 5;
      const decryptFailure = /decrypt|cdm|licen[cs]e|\bkeys?\b/i;
      const failedKeyStatus = /^(output-restricted|internal-error)$/;
      let drmSent = false;
      let refused = "";
      let refusedStage = "";
      const attempted = new Set();
      const grantedOnActivation = new WeakSet();
      const protectedKeys = new WeakMap();
      const protectedSessions = new WeakMap();
      const needsProtectedPlayback = (keySystem, stage) => {
        if (drmSent) return;
        drmSent = true;
        send("drm", { keySystem, stage });
      };
      const progressed = (m) => m.readyState >= 2 && m.currentTime > 0;
      const anyProgressed = () => [...attempted, ...document.querySelectorAll("video, audio")].some(progressed);
      const after = (ms, fn) => setTimeout(guard(fn), ms);
      const stalled = (m) => !m.paused && !m.ended && !progressed(m);
      const judgeAttempt = (m) =>
        after(GRACE_MS, () => {
          if (refused && stalled(m)) needsProtectedPlayback(refused, refusedStage);
        });
      const onAttempt = (m) => {
        if (attempted.size >= 16) attempted.delete(attempted.values().next().value);
        attempted.add(m);
        judgeAttempt(m);
      };
      const onNeedsKey = (m) =>
        after(KEYS_GRACE_MS, () => {
          if (!m.mediaKeys && !progressed(m)) needsProtectedPlayback(refused, refusedStage || "access");
        });
      const keysOf = (m) => (m.mediaKeys ? protectedKeys.get(m.mediaKeys) : undefined);
      const failedDecrypt = (error) =>
        error.code === MEDIA_ERR_ENCRYPTED || (error.code === MEDIA_ERR_DECODE && typeof error.message === "string" && apply(test, decryptFailure, [error.message]));
      const onMediaError = (m) => {
        if (!m.error) return;
        if (refused && m.error.code === MEDIA_ERR_DECODE) return needsProtectedPlayback(refused, refusedStage);
        const keys = keysOf(m);
        if (keys && failedDecrypt(m.error)) needsProtectedPlayback(keys.keySystem, "licence");
      };
      const onDrmMediaEvent = (e) => {
        const m = e.target;
        if (drmSent || !(m instanceof HTMLMediaElement)) return;
        if (e.type === "play") onAttempt(m);
        else if (e.type === "encrypted" || e.type === "waitingforkey") onNeedsKey(m);
        else if (e.type === "error") onMediaError(m);
      };
      const drmMediaEvents = ["play", "encrypted", "waitingforkey", "error"];
      for (const type of drmMediaEvents) document.addEventListener(type, guard(onDrmMediaEvent), true);
      detachedMediaWatchers.push((m) => {
        for (const type of drmMediaEvents) m.addEventListener(type, guard(onDrmMediaEvent));
      });
      const onRefused = (keySystem, activated, stage) => {
        if (drmSent) return;
        if (!refused || (refusedStage === "access" && stage !== "access")) {
          refused = keySystem;
          refusedStage = stage;
        }
        for (const m of attempted) if (stalled(m)) judgeAttempt(m);
        if (activated)
          after(GRACE_MS, () => {
            if (!anyProgressed()) needsProtectedPlayback(refused || keySystem, refusedStage || stage);
          });
      };
      const wrapped = asNative(requestAccess, (target, self, args) => {
        const result = apply(target, self, args);
        const keySystem = args[0];
        if (!drmSent && typeof keySystem === "string" && apply(test, protectedSystem, [keySystem])) {
          const activated = !!(navigator.userActivation && navigator.userActivation.isActive);
          const remember = guard((access) => activated && access && typeof access === "object" && grantedOnActivation.add(access));
          apply(then, result, [remember, () => onRefused(keySystem, activated, "access")]);
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
              const rememberKeys = guard((keys) => keys && typeof keys === "object" && protectedKeys.set(keys, { keySystem, activated }));
              apply(then, result, [rememberKeys, () => onRefused(keySystem, activated, "createMediaKeys")]);
            }
          }
          return result;
        });
        Object.defineProperty(AccessType.prototype, "createMediaKeys", {
          ...Object.getOwnPropertyDescriptor(AccessType.prototype, "createMediaKeys"),
          value: wrappedCreate,
        });
        const KeysType = window.MediaKeys;
        const SessionType = window.MediaKeySession;
        const createSession = KeysType && KeysType.prototype.createSession;
        const updateSession = SessionType && SessionType.prototype.update;
        const keyStatusesOf = SessionType && Object.getOwnPropertyDescriptor(SessionType.prototype, "keyStatuses");
        const StatusMap = window.MediaKeyStatusMap;
        const eachStatus = StatusMap && StatusMap.prototype.forEach;
        const listenOn = window.EventTarget && window.EventTarget.prototype.addEventListener;
        if (typeof createSession === "function" && typeof updateSession === "function") {
          const onSessionFailed = (session, stage) => {
            const keys = protectedSessions.get(session);
            if (keys) onRefused(keys.keySystem, keys.activated, stage);
          };
          const onKeyStatuses = guard((e) => {
            const session = e.target;
            if (drmSent || !protectedSessions.has(session)) return;
            const statuses = apply(keyStatusesOf.get, session, []);
            let failed = false;
            apply(eachStatus, statuses, [(status) => (failed = failed || (typeof status === "string" && apply(test, failedKeyStatus, [status])))]);
            if (failed) onSessionFailed(session, "keystatus");
          });
          const watchesStatuses = keyStatusesOf && typeof keyStatusesOf.get === "function" && typeof eachStatus === "function" && typeof listenOn === "function";
          const wrappedSession = asNative(createSession, (target, self, args) => {
            const session = apply(target, self, args);
            const keys = protectedKeys.get(self);
            if (keys && session && typeof session === "object") {
              protectedSessions.set(session, keys);
              if (watchesStatuses) apply(listenOn, session, ["keystatuseschange", onKeyStatuses]);
            }
            return session;
          });
          const wrappedUpdate = asNative(updateSession, (target, self, args) => {
            const result = apply(target, self, args);
            if (!drmSent && protectedSessions.has(self)) apply(then, result, [null, guard(() => onSessionFailed(self, "licence"))]);
            return result;
          });
          Object.defineProperty(KeysType.prototype, "createSession", {
            ...Object.getOwnPropertyDescriptor(KeysType.prototype, "createSession"),
            value: wrappedSession,
          });
          Object.defineProperty(SessionType.prototype, "update", {
            ...Object.getOwnPropertyDescriptor(SessionType.prototype, "update"),
            value: wrappedUpdate,
          });
        }
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

  const passkeysOn = true;
  try {
    const passkeyStore = navigator.credentials;
    const passkeyProto = passkeyStore && Object.getPrototypeOf(passkeyStore);
    const passkeyCreate = passkeyProto && passkeyProto.create;
    const passkeyGet = passkeyProto && passkeyProto.get;
    if (isTop && passkeysOn && typeof passkeyCreate === "function" && typeof passkeyGet === "function") {
      let passkeyKinds = null;
      const passkeyKindsOf = () => {
        if (passkeyKinds) return passkeyKinds;
        const credential = window.PublicKeyCredential;
        const attestation = window.AuthenticatorAttestationResponse;
        const assertion = window.AuthenticatorAssertionResponse;
        if (typeof credential !== "function" || typeof attestation !== "function" || typeof assertion !== "function") return null;
        passkeyKinds = { credential: credential.prototype, attestation: attestation.prototype, assertion: assertion.prototype };
        return passkeyKinds;
      };
      const PasskeyPromise = Promise;
      const passkeyThen = Promise.prototype.then;
      const PasskeyError = DOMException;
      const PasskeyBytes = Uint8Array;
      const PasskeyBuffer = ArrayBuffer;
      const PasskeyMap = Map;
      const passkeyMapGet = Map.prototype.get;
      const passkeyMapSet = Map.prototype.set;
      const passkeyMapDelete = Map.prototype.delete;
      const passkeyMapValues = Map.prototype.values;
      const passkeyIterNext = Object.getPrototypeOf(new Map().values()).next;
      const passkeyIsView = ArrayBuffer.isView;
      const passkeySlice = ArrayBuffer.prototype.slice;
      const passkeyIsArray = Array.isArray;
      const passkeyArraySlice = Array.prototype.slice;
      const PASSKEY_HEX = "0123456789abcdef";
      const { create: passkeyMake, defineProperty: passkeyDefine } = Object;
      const passkeyHasOwn = Object.prototype.hasOwnProperty;
      const passkeyFromCharCode = String.fromCharCode;
      const passkeyCharCodeAt = String.prototype.charCodeAt;
      const passkeyReplace = String.prototype.replace;
      const passkeyBtoa = window.btoa;
      const passkeyAtob = window.atob;
      const passkeyTimer = window.setTimeout;
      const passkeyClearTimer = window.clearTimeout;
      const passkeyListen = EventTarget.prototype.addEventListener;
      const passkeyUnlisten = EventTarget.prototype.removeEventListener;
      const passkeyCrypto = window.crypto;
      const passkeyRandom = passkeyCrypto && passkeyCrypto.getRandomValues;
      const passkeyGetterOf = (proto, name) => {
        const property = proto ? Object.getOwnPropertyDescriptor(proto, name) : null;
        return property && property.get;
      };
      const passkeyAborted = passkeyGetterOf(window.AbortSignal && AbortSignal.prototype, "aborted");
      const passkeyReason = passkeyGetterOf(window.AbortSignal && AbortSignal.prototype, "reason");
      const passkeyViewBuffer = passkeyGetterOf(Object.getPrototypeOf(Uint8Array.prototype), "buffer");
      const passkeyViewOffset = passkeyGetterOf(Object.getPrototypeOf(Uint8Array.prototype), "byteOffset");
      const passkeyViewLength = passkeyGetterOf(Object.getPrototypeOf(Uint8Array.prototype), "byteLength");
      const passkeyDataBuffer = passkeyGetterOf(window.DataView && DataView.prototype, "buffer");
      const passkeyDataOffset = passkeyGetterOf(window.DataView && DataView.prototype, "byteOffset");
      const passkeyDataLength = passkeyGetterOf(window.DataView && DataView.prototype, "byteLength");
      const PASSKEY_ACK_MS = 3000;
      const PASSKEY_LONGEST_WAIT_MS = 630000;
      const PASSKEY_LONGEST_MESSAGE = 60000;
      const PASSKEY_LONGEST_TEXT = 1024;
      const PASSKEY_MOST_ITEMS = 64;
      const passkeyPending = new PasskeyMap();
      const PasskeyWeakSet = WeakSet;
      const passkeyWeakAdd = WeakSet.prototype.add;
      const passkeyWeakHas = WeakSet.prototype.has;
      const passkeyMapKeys = Map.prototype.keys;
      const passkeyExec = RegExp.prototype.exec;
      const passkeySplit = String.prototype.split;
      const passkeyWeakDelete = WeakSet.prototype.delete;
      const PasskeyStackError = Error;
      const passkeyContenders = { passkeyCreate: new PasskeyMap(), passkeyGet: new PasskeyMap() };
      const passkeyHandedOff = new PasskeyWeakSet();
      const PASSKEY_EXTENSION_FRAME = /^\s*at (?:.* \()?chrome-extension:\/\/([a-p]{32})\//;

      const passkeyOwnOrNull = (o, name) => {
        try {
          return o[name];
        } catch (e) {
          return null;
        }
      };
      const passkeyOwn = (o, name) => (o !== null && typeof o === "object" && apply(passkeyHasOwn, o, [name]) ? o[name] : undefined);
      const passkeyRequestId = () => {
        const bytes = new PasskeyBytes(16);
        apply(passkeyRandom, passkeyCrypto, [bytes]);
        let id = "";
        for (let i = 0; i < bytes.length; i++) id += PASSKEY_HEX[bytes[i] >> 4] + PASSKEY_HEX[bytes[i] & 15];
        return id;
      };
      const passkeyBytesOf = (source) => {
        if (source instanceof PasskeyBuffer) return new PasskeyBytes(source);
        if (apply(passkeyIsView, PasskeyBuffer, [source])) {
          if (source instanceof DataView) return new PasskeyBytes(apply(passkeyDataBuffer, source, []), apply(passkeyDataOffset, source, []), apply(passkeyDataLength, source, []));
          return new PasskeyBytes(apply(passkeyViewBuffer, source, []), apply(passkeyViewOffset, source, []), apply(passkeyViewLength, source, []));
        }
        throw new TypeError("not a BufferSource");
      };
      const passkeyEncode = (source) => {
        const bytes = passkeyBytesOf(source);
        let binary = "";
        for (let i = 0; i < bytes.length; i += 4096) binary += apply(passkeyFromCharCode, null, apply(passkeyArraySlice, bytes, [i, i + 4096]));
        const base64 = apply(passkeyBtoa, window, [binary]);
        return apply(passkeyReplace, apply(passkeyReplace, apply(passkeyReplace, base64, [/\+/g, "-"]), [/\//g, "_"]), [/=+$/, ""]);
      };
      const passkeyDecode = (text) => {
        if (typeof text !== "string") return null;
        let base64 = apply(passkeyReplace, apply(passkeyReplace, text, [/-/g, "+"]), [/_/g, "/"]);
        while (base64.length % 4) base64 += "=";
        const binary = apply(passkeyAtob, window, [base64]);
        const bytes = new PasskeyBytes(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = apply(passkeyCharCodeAt, binary, [i]);
        return bytes.buffer;
      };
      const passkeyText = (value) => {
        if (value === undefined) return undefined;
        if (typeof value !== "string") throw new TypeError("not a string");
        return value.length > PASSKEY_LONGEST_TEXT ? value.slice(0, PASSKEY_LONGEST_TEXT) : value;
      };
      const passkeyList = (value, each) => {
        if (value === undefined || value === null) return undefined;
        if (!passkeyIsArray(value) || value.length > PASSKEY_MOST_ITEMS) throw new TypeError("not a list");
        const out = [];
        for (let i = 0; i < value.length; i++) out.push(each(value[i]));
        return out;
      };
      const passkeyDescriptor = (d) => ({ type: passkeyText(d && d.type), id: passkeyEncode(d && d.id) });
      const passkeyCreation = (pk) => {
        const rp = pk.rp || {};
        const user = pk.user || {};
        const selection = pk.authenticatorSelection;
        const extensions = pk.extensions;
        return {
          challenge: passkeyEncode(pk.challenge),
          rp: { id: passkeyText(rp.id), name: passkeyText(rp.name) },
          user: { id: passkeyEncode(user.id), name: passkeyText(user.name), displayName: passkeyText(user.displayName) },
          pubKeyCredParams: passkeyList(pk.pubKeyCredParams, (p) => ({ type: passkeyText(p && p.type), alg: typeof (p && p.alg) === "number" ? p.alg : null })),
          timeout: typeof pk.timeout === "number" ? pk.timeout : undefined,
          excludeCredentials: passkeyList(pk.excludeCredentials, passkeyDescriptor),
          authenticatorSelection: selection ? { authenticatorAttachment: passkeyText(selection.authenticatorAttachment) } : undefined,
          attestation: passkeyText(pk.attestation),
          hints: passkeyList(pk.hints, passkeyText),
          extensions: extensions ? { credProps: extensions.credProps === true } : undefined,
        };
      };
      const passkeyAssertionOptions = (pk) => {
        const extensions = pk.extensions;
        return {
          challenge: passkeyEncode(pk.challenge),
          rpId: passkeyText(pk.rpId),
          timeout: typeof pk.timeout === "number" ? pk.timeout : undefined,
          allowCredentials: passkeyList(pk.allowCredentials, passkeyDescriptor),
          hints: passkeyList(pk.hints, passkeyText),
          extensions: extensions ? { appid: passkeyText(extensions.appid) } : undefined,
        };
      };
      const passkeyValue = (target, name, value) => passkeyDefine(target, name, { value, enumerable: true, configurable: true });
      const passkeyMethod = (target, name, fn) => passkeyDefine(target, name, { value: fn, configurable: true, writable: true });
      const passkeyCopy = (buffer) => (buffer ? apply(passkeySlice, buffer, [0]) : null);
      const passkeyExtensions = (raw) => {
        const out = {};
        const props = passkeyOwn(raw, "credProps");
        if (props) out.credProps = { rk: passkeyOwn(props, "rk") === true };
        if (passkeyOwn(raw, "appid") === false) out.appid = false;
        return out;
      };
      const passkeyStrings = (raw) => {
        const out = [];
        if (passkeyIsArray(raw)) for (let i = 0; i < raw.length; i++) if (typeof raw[i] === "string") out.push(raw[i]);
        return out;
      };
      const passkeyCredentialOf = (raw) => {
        const made = passkeyOwn(raw, "kind") === "create";
        const id = passkeyOwn(raw, "id");
        if (typeof id !== "string") throw new TypeError("no id");
        const texts = {};
        const names = made ? ["clientDataJSON", "attestationObject", "authenticatorData", "publicKey"] : ["clientDataJSON", "authenticatorData", "signature", "userHandle"];
        for (let i = 0; i < names.length; i++) {
          const value = passkeyOwn(raw, names[i]);
          texts[names[i]] = typeof value === "string" ? value : null;
        }
        const kinds = passkeyKindsOf();
        const response = passkeyMake(kinds ? (made ? kinds.attestation : kinds.assertion) : Object.prototype);
        const buffers = {};
        for (let i = 0; i < names.length; i++) buffers[names[i]] = texts[names[i]] === null ? null : passkeyDecode(texts[names[i]]);
        const extensionsRaw = passkeyOwn(raw, "extensions");
        const algorithm = passkeyOwn(raw, "publicKeyAlgorithm");
        const transports = passkeyStrings(passkeyOwn(raw, "transports"));
        passkeyValue(response, "clientDataJSON", buffers.clientDataJSON);
        if (made) {
          passkeyValue(response, "attestationObject", buffers.attestationObject);
          passkeyMethod(response, "getTransports", () => transports.slice());
          passkeyMethod(response, "getAuthenticatorData", () => passkeyCopy(buffers.authenticatorData));
          passkeyMethod(response, "getPublicKey", () => passkeyCopy(buffers.publicKey));
          passkeyMethod(response, "getPublicKeyAlgorithm", () => (typeof algorithm === "number" ? algorithm : -7));
        } else {
          passkeyValue(response, "authenticatorData", buffers.authenticatorData);
          passkeyValue(response, "signature", buffers.signature);
          passkeyValue(response, "userHandle", buffers.userHandle);
        }
        const credential = passkeyMake(kinds ? kinds.credential : Object.prototype);
        passkeyValue(credential, "id", id);
        passkeyValue(credential, "rawId", passkeyDecode(id));
        passkeyValue(credential, "type", "public-key");
        passkeyValue(credential, "authenticatorAttachment", "platform");
        passkeyValue(credential, "response", response);
        passkeyMethod(credential, "getClientExtensionResults", () => passkeyExtensions(extensionsRaw));
        passkeyMethod(credential, "toJSON", () => {
          const json = made
            ? { clientDataJSON: texts.clientDataJSON, attestationObject: texts.attestationObject, transports: transports.slice() }
            : { clientDataJSON: texts.clientDataJSON, authenticatorData: texts.authenticatorData, signature: texts.signature };
          if (made && texts.authenticatorData) json.authenticatorData = texts.authenticatorData;
          if (made && texts.publicKey) json.publicKey = texts.publicKey;
          if (made) json.publicKeyAlgorithm = typeof algorithm === "number" ? algorithm : -7;
          if (!made && texts.userHandle) json.userHandle = texts.userHandle;
          return { id, rawId: id, type: "public-key", authenticatorAttachment: "platform", response: json, clientExtensionResults: passkeyExtensions(extensionsRaw) };
        });
        return credential;
      };
      const passkeySettle = (id) => {
        const entry = apply(passkeyMapGet, passkeyPending, [id]);
        if (!entry) return null;
        apply(passkeyMapDelete, passkeyPending, [id]);
        if (entry.ack) apply(passkeyClearTimer, window, [entry.ack]);
        if (entry.signal && entry.onAbort) apply(passkeyUnlisten, entry.signal, ["abort", entry.onAbort]);
        return entry;
      };
      const passkeyExtensionCalling = () => {
        let stack = "";
        try {
          stack = String(new PasskeyStackError().stack || "");
        } catch (e) {}
        const lines = apply(passkeySplit, stack, ["\n"]);
        const caller = lines.length > 3 ? lines[3] : "";
        const found = apply(passkeyExec, PASSKEY_EXTENSION_FRAME, [caller]);
        return found ? found[1] : null;
      };
      const passkeyExtensionsFor = (kind) => {
        const ids = [];
        const iterator = apply(passkeyMapKeys, passkeyContenders[kind], []);
        for (let step = apply(passkeyIterNext, iterator, []); !step.done; step = apply(passkeyIterNext, iterator, [])) ids[ids.length] = step.value;
        return ids;
      };
      const passkeyTopContender = (kind) => {
        const ids = passkeyExtensionsFor(kind);
        return ids.length ? apply(passkeyMapGet, passkeyContenders[kind], [ids[ids.length - 1]]) : null;
      };
      const passkeyMarks = (options) => {
        const marks = [];
        if (options && typeof options === "object") {
          marks[marks.length] = options;
          const pk = passkeyOwnOrNull(options, "publicKey");
          if (pk && typeof pk === "object") marks[marks.length] = pk;
        }
        return marks;
      };
      const passkeyHandOff = (fn, self, options) => {
        const marks = passkeyMarks(options);
        for (let i = 0; i < marks.length; i++) apply(passkeyWeakAdd, passkeyHandedOff, [marks[i]]);
        const clear = () => {
          for (let i = 0; i < marks.length; i++) apply(passkeyWeakDelete, passkeyHandedOff, [marks[i]]);
        };
        try {
          const settled = PasskeyPromise.resolve(apply(fn, self, [options]));
          apply(passkeyThen, settled, [clear, clear]);
          return settled;
        } catch (e) {
          clear();
          return PasskeyPromise.reject(e);
        }
      };
      const passkeyHandedOffAlready = (options) => {
        const marks = passkeyMarks(options);
        for (let i = 0; i < marks.length; i++) if (apply(passkeyWeakHas, passkeyHandedOff, [marks[i]])) return true;
        return false;
      };
      const passkeyUnclaimed = (target, self, args, kind) => {
        const top = passkeyTopContender(kind);
        return top ? passkeyHandOff(top, self, args[0]) : apply(target, self, args);
      };
      const passkeyRun = (original, self, options, kind, message, mediation, signal) =>
        new PasskeyPromise((resolve, reject) => {
          const id = passkeyRequestId();
          const request = { id, options: message, mediation, extensions: passkeyExtensionsFor(kind) };
          const json = serialize(request);
          if (json.length > PASSKEY_LONGEST_MESSAGE) return resolve(passkeyUnclaimed(original, self, [options], kind));
          const entry = { id, resolve, reject, signal, onAbort: null, ack: 0, conditional: mediation === "conditional" };
          const settle = (work) => {
            try {
              resolve(work());
            } catch (e) {
              reject(e);
            }
          };
          entry.fallback = () =>
            settle(() => {
              const top = passkeyTopContender(kind);
              return top ? passkeyHandOff(top, self, options) : apply(original, self, [options]);
            });
          entry.chrome = () => settle(() => apply(original, self, [options]));
          entry.extension = (extensionId) =>
            settle(() => {
              const fn = apply(passkeyMapGet, passkeyContenders[kind], [extensionId]);
              return fn ? passkeyHandOff(fn, self, options) : apply(original, self, [options]);
            });
          if (signal) {
            entry.onAbort = () => {
              if (!passkeySettle(id)) return;
              send("passkeyCancel", { id });
              reject(apply(passkeyReason, signal, []) ?? new PasskeyError("The operation was aborted.", "AbortError"));
            };
            apply(passkeyListen, signal, ["abort", entry.onAbort, { once: true }]);
          }
          entry.ack = apply(passkeyTimer, window, [
            () => {
              const late = passkeySettle(id);
              if (late) late.fallback();
            },
            PASSKEY_ACK_MS,
          ]);
          apply(passkeyMapSet, passkeyPending, [id, entry]);
          if (kind === "passkeyCreate") send("passkeyCreate", request);
          else send("passkeyGet", request);
        });
      const passkeyWrap = (original, kind) =>
        asNative(original, (target, self, args) => {
          const options = args[0];
          if (passkeyHandedOffAlready(options)) return apply(target, self, args);
          if (self !== passkeyStore) return apply(target, self, args);
          let message = null;
          let mediation;
          let signal;
          try {
            const pk = options && typeof options === "object" ? options.publicKey : undefined;
            const plain = !!pk && typeof pk === "object" && !(options.password || options.federated || options.identity || options.otp);
            mediation = plain ? options.mediation : undefined;
            signal = plain ? options.signal : undefined;
            const usable =
              plain &&
              (mediation === undefined || typeof mediation === "string") &&
              (signal === undefined || signal === null || (!!passkeyAborted && !apply(passkeyAborted, signal, [])));
            if (usable) message = kind === "passkeyCreate" ? passkeyCreation(pk) : passkeyAssertionOptions(pk);
          } catch (e) {
            message = null;
          }
          if (!message) return passkeyUnclaimed(target, self, args, kind);
          return passkeyRun(target, self, options, kind, message, mediation, signal || null);
        });
      handlers.passkey = (message) => {
        const id = passkeyOwn(message, "id");
        if (typeof id !== "string") return;
        if (passkeyOwn(message, "ack") === true) {
          const entry = apply(passkeyMapGet, passkeyPending, [id]);
          if (entry && entry.ack) {
            apply(passkeyClearTimer, window, [entry.ack]);
            entry.ack = entry.conditional
              ? 0
              : apply(passkeyTimer, window, [
                  () => {
                    if (!passkeySettle(id)) return;
                    send("passkeyCancel", { id });
                    entry.reject(new PasskeyError("The operation either timed out or was not allowed.", "NotAllowedError"));
                  },
                  PASSKEY_LONGEST_WAIT_MS,
                ]);
          }
          return;
        }
        const entry = passkeySettle(id);
        if (!entry) return;
        if (passkeyOwn(message, "fallback") === true) return entry.fallback();
        if (passkeyOwn(message, "chrome") === true) return entry.chrome();
        const extension = passkeyOwn(message, "extension");
        if (typeof extension === "string") return entry.extension(extension);
        const error = passkeyOwn(message, "error");
        if (typeof error === "string") {
          const name = error === "InvalidStateError" || error === "AbortError" ? error : "NotAllowedError";
          return entry.reject(new PasskeyError(name === "InvalidStateError" ? "The authenticator was previously registered." : "The operation either timed out or was not allowed.", name));
        }
        try {
          entry.resolve(passkeyCredentialOf(passkeyOwn(message, "credential")));
        } catch (e) {
          entry.reject(new PasskeyError("The operation either timed out or was not allowed.", "NotAllowedError"));
        }
      };
      apply(passkeyListen, window, [
        "pagehide",
        () => {
          const entries = [];
          const iterator = apply(passkeyMapValues, passkeyPending, []);
          for (let step = apply(passkeyIterNext, iterator, []); !step.done; step = apply(passkeyIterNext, iterator, [])) entries[entries.length] = step.value;
          for (let i = 0; i < entries.length; i++) {
            if (!passkeySettle(entries[i].id)) continue;
            send("passkeyCancel", { id: entries[i].id });
            entries[i].reject(new PasskeyError("The operation was aborted.", "AbortError"));
          }
        },
      ]);
      const passkeyTrap = (name, kind, wrapped) =>
        passkeyDefine(passkeyProto, name, {
          configurable: true,
          enumerable: true,
          get: () => wrapped,
          set(value) {
            const native = () => {
              try {
                passkeyDefine(this, name, { value, writable: true, configurable: true, enumerable: true });
              } catch (e) {}
            };
            try {
              const extension = passkeyExtensionCalling();
              if (!extension) return native();
              let label = "";
              try {
                label = typeof value === "function" ? String(value.name) : "";
              } catch (e) {}
              const restoring = value === wrapped || label === "bound " + name;
              if (typeof value !== "function" || restoring) apply(passkeyMapDelete, passkeyContenders[kind], [extension]);
              else if (!apply(passkeyMapGet, passkeyContenders[kind], [extension])) apply(passkeyMapSet, passkeyContenders[kind], [extension, value]);
            } catch (e) {
              native();
            }
          },
        });
      passkeyTrap("create", "passkeyCreate", passkeyWrap(passkeyCreate, "passkeyCreate"));
      passkeyTrap("get", "passkeyGet", passkeyWrap(passkeyGet, "passkeyGet"));
      let passkeyStaticsWrapped = false;
      const passkeyWrapStatics = () => {
        const credential = window.PublicKeyCredential;
        if (passkeyStaticsWrapped || typeof credential !== "function") return;
        passkeyStaticsWrapped = true;
        passkeyKindsOf();
        const conditional = credential.isConditionalMediationAvailable;
        const platform = credential.isUserVerifyingPlatformAuthenticatorAvailable;
        if (typeof conditional === "function") credential.isConditionalMediationAvailable = asNative(conditional, () => PasskeyPromise.resolve(true));
        if (typeof platform === "function") credential.isUserVerifyingPlatformAuthenticatorAvailable = asNative(platform, () => PasskeyPromise.resolve(true));
      };
      passkeyWrapStatics();
      if (!passkeyStaticsWrapped) {
        apply(passkeyThen, PasskeyPromise.resolve(), [guard(passkeyWrapStatics)]);
        apply(passkeyTimer, window, [guard(passkeyWrapStatics), 0]);
        apply(passkeyListen, document, ["readystatechange", guard(passkeyWrapStatics)]);
      }
    }
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
    if (config.fieldProvider !== undefined) handlers.fieldProvider(config.fieldProvider);
  };
  send("hello", { top: isTop, url: location.href });
  const tellExclusive = guard(() => send("exclusive", { held: !!(document.pointerLockElement || document.fullscreenElement) }));
  document.addEventListener("pointerlockchange", tellExclusive);
  document.addEventListener("fullscreenchange", tellExclusive);

  if (!isTop) return receive;

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
