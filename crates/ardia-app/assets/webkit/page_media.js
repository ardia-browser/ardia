(() => {
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
  const dispatch = EventTarget.prototype.dispatchEvent;
  const listen = EventTarget.prototype.addEventListener;
  const preventDefault = Event.prototype.preventDefault;
  const detailOf = Object.getOwnPropertyDescriptor(CustomEvent.prototype, "detail").get;
  const connected = Object.getOwnPropertyDescriptor(Node.prototype, "isConnected").get;
  const { stringify, parse } = JSON;
  const Custom = CustomEvent;
  const Mouse = MouseEvent;
  const now = Date.now;
  const doc = document;
  const NativePromise = Promise;
  const then = Promise.prototype.then;
  const sites = ["netflix.com","disneyplus.com","max.com","hbomax.com","primevideo.com","hulu.com","tv.apple.com","music.apple.com","open.spotify.com","peacocktv.com","paramountplus.com","crunchyroll.com","hotstar.com","jiohotstar.com","v.qq.com","audible.com","audible.co.uk","audible.ca","audible.com.au","audible.de","audible.fr","audible.it","audible.es","audible.co.jp","audible.in","audible.com.br","canalplus.com","mycanal.fr","tv.youtube.com","osnplus.com","anghami.com"];
  const watched = location.protocol === "https:" && sites.some((site) => location.hostname === site || location.hostname.endsWith("." + site));
  const noop = () => {};
  const reported = Object.create(null);
  const fault = (reason) => {
    reported[reason] = (reported[reason] || 0) + 1;
    if (reported[reason] > 20) return;
    apply(dispatch, doc, [new Custom("ardia:media-fault", { detail: reason })]);
  };
  const observe = (promise, onValue, onError) =>
    apply(then, promise, [
      (value) => {
        try {
          onValue(value);
        } catch (e) {}
        return value;
      },
      (error) => {
        try {
          onError(error);
        } catch (e) {}
        throw error;
      },
    ]);
  const handedOver = new WeakSet();
  const errorsHeard = new WeakSet();
  const errorEventsCounted = new WeakSet();
  const mediaProto = HTMLMediaElement.prototype;
  const connectedOf = (media) => {
    try {
      return apply(connected, media, []);
    } catch (e) {
      return null;
    }
  };
  mediaProto.play = asNative(mediaProto.play, (play, self, args) => {
    const isConnected = connectedOf(self);
    if (isConnected === false && !handedOver.has(self)) {
      handedOver.add(self);
      try {
        apply(dispatch, doc, [new Mouse("ardia:media-element", { relatedTarget: self })]);
      } catch (e) {}
    }
    if (watched && isConnected === false && !errorsHeard.has(self)) {
      errorsHeard.add(self);
      apply(listen, self, ["error", reportMediaError]);
    }
    const result = apply(play, self, args);
    return watched && result instanceof NativePromise ? observe(result, noop, (error) => fault("play_rejected_" + playRejection(error))) : result;
  });

  const getter = (proto, name) => {
    const d = proto && Object.getOwnPropertyDescriptor(proto, name);
    return d && d.get;
  };
  const read = (get, target) => (typeof get === "function" ? apply(get, target, []) : undefined);
  const nameOf = getter(DOMException.prototype, "name");
  const targetOf = getter(Event.prototype, "target");
  const mediaErrorOf = getter(HTMLMediaElement.prototype, "error");
  const mediaErrorCodeOf = getter(MediaError.prototype, "code");
  const errorName = (error) => (error instanceof DOMException ? read(nameOf, error) : "");
  const refusal = (error) => {
    switch (errorName(error)) {
      case "NotSupportedError":
        return "not_supported";
      case "SecurityError":
        return "security";
      case "NotAllowedError":
        return "not_allowed";
      default:
        return "other";
    }
  };
  const playRejection = (error) => {
    switch (errorName(error)) {
      case "NotAllowedError":
        return "not_allowed";
      case "NotSupportedError":
        return "not_supported";
      case "AbortError":
        return "abort";
      default:
        return "other";
    }
  };
  const keySystem = (name) => {
    if (typeof name !== "string") return "other";
    if (name.startsWith("com.widevine.alpha")) return "widevine";
    if (name.startsWith("com.microsoft.playready")) return "playready";
    if (name.startsWith("com.apple.fps")) return "fairplay";
    return "other";
  };
  const mediaError = (code) => {
    switch (code) {
      case 1:
        return "media_error_aborted";
      case 2:
        return "media_error_network";
      case 3:
        return "media_error_decode";
      case 4:
        return "media_error_src_not_supported";
      default:
        return null;
    }
  };
  const requestAccess = Navigator.prototype.requestMediaKeySystemAccess;
  if (watched && typeof requestAccess === "function") {
    Navigator.prototype.requestMediaKeySystemAccess = function (name, configurations) {
      const result = apply(requestAccess, this, arguments);
      if (!(result instanceof NativePromise)) return result;
      const system = keySystem(name);
      return observe(
        result,
        () => fault("eme_" + system + "_granted"),
        (error) => fault("eme_" + system + "_refused_" + refusal(error)),
      );
    };
  }
  const LegacyKeys = window.WebKitMediaKeys;
  const legacySessionErrorOf = getter(window.WebKitMediaKeySession && WebKitMediaKeySession.prototype, "error");
  const legacyErrorCodeOf = getter(window.WebKitMediaKeyError && WebKitMediaKeyError.prototype, "code");
  const legacyKeyErrors = [null, "unknown", "client", "service", "output", "hardware_change", "domain"];
  const reportLegacyKeyError = (e) => {
    try {
      const error = read(legacySessionErrorOf, read(targetOf, e));
      const name = error && legacyKeyErrors[read(legacyErrorCodeOf, error)];
      if (name) fault("eme_legacy_key_error_" + name);
    } catch (err) {}
  };
  if (watched && typeof LegacyKeys === "function") {
    const isTypeSupported = LegacyKeys.isTypeSupported;
    if (typeof isTypeSupported === "function") {
      LegacyKeys.isTypeSupported = function (name) {
        const supported = apply(isTypeSupported, this, arguments);
        try {
          const reason = "eme_" + keySystem(name) + "_legacy_" + (supported ? "supported" : "unsupported");
          if (!reported[reason]) fault(reason);
        } catch (e) {}
        return supported;
      };
    }
    const createSession = LegacyKeys.prototype && LegacyKeys.prototype.createSession;
    if (typeof createSession === "function") {
      LegacyKeys.prototype.createSession = function () {
        const session = apply(createSession, this, arguments);
        try {
          if (session) apply(listen, session, ["webkitkeyerror", reportLegacyKeyError]);
        } catch (e) {}
        return session;
      };
    }
  }
  function reportMediaError(e) {
    try {
      if (errorEventsCounted.has(e)) return;
      errorEventsCounted.add(e);
      const target = read(targetOf, e);
      if (!(target instanceof HTMLMediaElement)) return;
      const error = read(mediaErrorOf, target);
      const reason = error && mediaError(read(mediaErrorCodeOf, error));
      if (reason) fault(reason);
    } catch (err) {}
  }
  if (watched) apply(listen, doc, ["error", reportMediaError, true]);

  const session = navigator.mediaSession;
  const proto = session && Object.getPrototypeOf(session);
  if (!proto) return;
  const handlers = new Map();
  let position = null;
  let samples = 0;
  const notify = () => {
    try {
      apply(dispatch, doc, [new Custom("ardia:media-session", { detail: stringify({ actions: Array.from(handlers.keys()), position }) })]);
    } catch (e) {}
  };
  if (typeof proto.setActionHandler === "function") {
    proto.setActionHandler = asNative(proto.setActionHandler, (setActionHandler, self, args) => {
      const result = apply(setActionHandler, self, args);
      const [action, handler] = args;
      if (typeof handler === "function") handlers.set(String(action), handler);
      else handlers.delete(String(action));
      notify();
      return result;
    });
  }
  if (typeof proto.setPositionState === "function") {
    proto.setPositionState = asNative(proto.setPositionState, (setPositionState, self, args) => {
      const result = apply(setPositionState, self, args);
      const state = args[0];
      position =
        state && typeof state === "object"
          ? { duration: +state.duration, position: +(state.position || 0), playbackRate: +(state.playbackRate || 1), at: now(), id: ++samples, playing: self.playbackState === "playing" }
          : null;
      notify();
      return result;
    });
  }
  for (const name of ["metadata", "playbackState"]) {
    const d = Object.getOwnPropertyDescriptor(proto, name);
    if (!d || !d.set) continue;
    Object.defineProperty(proto, name, {
      ...d,
      set: asNative(d.set, (set, self, args) => {
        apply(set, self, args);
        notify();
      }),
    });
  }
  apply(listen, doc, [
    "ardia:media-action",
    (e) => {
      let request = null;
      try {
        request = parse(apply(detailOf, e, []));
      } catch (error) {}
      const handler = request && typeof request.action === "string" ? handlers.get(request.action) : null;
      if (typeof handler !== "function") return;
      apply(preventDefault, e, []);
      const details = { action: request.action };
      if (typeof request.seekOffset === "number") details.seekOffset = request.seekOffset;
      if (typeof request.seekTime === "number") details.seekTime = request.seekTime;
      try {
        handler(details);
      } catch (error) {}
    },
    true,
  ]);
})();(() => {
  const isTop = window === window.top;
  const apply = Reflect.apply;
  const { isFinite } = Number;
  const dispatch = EventTarget.prototype.dispatchEvent;
  const Custom = CustomEvent;
  const { stringify } = JSON;
  const doc = document;
  const send = (kind, data) => {
    try {
      apply(dispatch, doc, [new Custom("ardia:app-badge", { detail: stringify(data) })]);
    } catch (e) {}
  };
  const guard = (fn) =>
    function () {
      try {
        return apply(fn, this, arguments);
      } catch (e) {}
    };
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
})();
