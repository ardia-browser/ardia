import Foundation

public struct PageMediaReport: Equatable, Sendable {
  public enum State: String, Sendable {
    case playing
    case paused
    case none
  }

  public var token: String
  public var state: State
  public var hasVideo: Bool
  public var title: String
  public var artist: String
  public var artworkURL: String?
  public var duration: Double?
  public var position: Double
  public var rate: Double
  public var canPrevious: Bool
  public var canNext: Bool
  public var canPictureInPicture: Bool
  public var inPictureInPicture: Bool
  public var isFullscreen: Bool
  public var plays: Int

  public static let longestText = 200
  public static let longestArtworkURL = 2048
  public static let longestDuration: Double = 7 * 24 * 3600
  public static let fastestRate: Double = 16
  public static let mostPlays = 1_000_000

  public init(token: String, state: State, hasVideo: Bool = false, title: String = "", artist: String = "", artworkURL: String? = nil, duration: Double? = nil, position: Double = 0, rate: Double = 1, canPrevious: Bool = false, canNext: Bool = false, canPictureInPicture: Bool = false, inPictureInPicture: Bool = false, isFullscreen: Bool = false, plays: Int = 0) {
    self.token = token
    self.state = state
    self.hasVideo = hasVideo
    self.title = title
    self.artist = artist
    self.artworkURL = artworkURL
    self.duration = duration
    self.position = position
    self.rate = rate
    self.canPrevious = canPrevious
    self.canNext = canNext
    self.canPictureInPicture = canPictureInPicture
    self.inPictureInPicture = inPictureInPicture
    self.isFullscreen = isFullscreen
    self.plays = plays
  }

  public static func parse(_ body: Any?) -> PageMediaReport? {
    guard let fields = body as? [String: Any], fields["type"] as? String == "media",
          let token = PageMediaMessage.token(fields["token"]),
          let state = (fields["state"] as? String).flatMap(State.init(rawValue:)) else { return nil }
    let duration = finite(fields["duration"]).flatMap { $0 > 0 && $0 <= longestDuration ? $0 : nil }
    let position = min(max(finite(fields["position"]) ?? 0, 0), duration ?? longestDuration)
    return PageMediaReport(
      token: token,
      state: state,
      hasVideo: flag(fields["hasVideo"]),
      title: cleanText(fields["title"]),
      artist: cleanText(fields["artist"]),
      artworkURL: artwork(fields["artwork"]),
      duration: duration,
      position: position,
      rate: min(max(finite(fields["rate"]) ?? 1, 0), fastestRate),
      canPrevious: flag(fields["canPrevious"]),
      canNext: flag(fields["canNext"]),
      canPictureInPicture: flag(fields["canPictureInPicture"]),
      inPictureInPicture: flag(fields["inPictureInPicture"]),
      isFullscreen: flag(fields["isFullscreen"]),
      plays: Int(min(max(finite(fields["plays"]) ?? 0, 0), Double(mostPlays)))
    )
  }

  public static func cleanText(_ value: Any?) -> String {
    guard let text = value as? String else { return "" }
    var kept = String.UnicodeScalarView()
    var lastWasSpace = true
    for scalar in text.unicodeScalars.prefix(longestText * 4) {
      let category = scalar.properties.generalCategory
      let joins = scalar.value == 0x200D && !lastWasSpace
      let isSpace = !joins && (scalar.properties.isWhitespace || category == .control || category == .format || category == .lineSeparator || category == .paragraphSeparator || category == .surrogate || category == .privateUse || category == .unassigned)
      if isSpace {
        if !lastWasSpace { kept.append(" ") }
        lastWasSpace = true
      } else {
        kept.append(scalar)
        lastWasSpace = false
      }
    }
    let trimmed = String(kept).trimmingCharacters(in: .whitespaces)
    return trimmed.count > longestText ? String(trimmed.prefix(longestText)) : trimmed
  }

  static func artwork(_ value: Any?) -> String? {
    guard let text = value as? String, !text.isEmpty, text.utf8.count <= longestArtworkURL,
          !text.unicodeScalars.contains(where: { $0.properties.isWhitespace || $0.properties.generalCategory == .control || $0.properties.generalCategory == .format || $0.value > 0x7E }),
          let components = URLComponents(string: text), components.scheme?.lowercased() == "https",
          let host = components.host, !host.isEmpty, components.user == nil, components.password == nil,
          let url = components.url else { return nil }
    return url.absoluteString
  }

  static func finite(_ value: Any?) -> Double? {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
    let double = number.doubleValue
    return double.isFinite ? double : nil
  }

  static func flag(_ value: Any?) -> Bool {
    guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return false }
    return number.boolValue
  }
}

public enum PageMediaLeaveOutcome: String, Sendable {
  case held
  case resumed
  case refused
}

public enum PageMediaMessage: Sendable, Equatable {
  case report(PageMediaReport)
  case left(token: String, outcome: PageMediaLeaveOutcome)

  public static func parse(_ body: Any?) -> PageMediaMessage? {
    if let report = PageMediaReport.parse(body) { return .report(report) }
    guard let fields = body as? [String: Any], fields["type"] as? String == "left", let token = token(fields["token"]),
          let outcome = (fields["outcome"] as? String).flatMap(PageMediaLeaveOutcome.init(rawValue:)) else { return nil }
    return .left(token: token, outcome: outcome)
  }

  static func token(_ value: Any?) -> String? {
    guard let text = value as? String, (6...16).contains(text.utf8.count), text.utf8.allSatisfy({ (0x30...0x39).contains($0) || (0x61...0x7A).contains($0) }) else { return nil }
    return text
  }
}

public enum PageMediaCommand: String, CaseIterable, Sendable {
  case play
  case pause
  case skip
  case previous
  case next
  case pictureInPicture
  case leavePictureInPicture
  case leave
  case returned
  case keepPlaying

  public static let skipChoices: [Int] = [10, 15, 30]
  public static let standardSkip = 15

  public static func skipSeconds(_ value: Double?) -> Int? {
    guard let value, let choice = skipChoices.first(where: { Double($0) == value.magnitude }) else { return nil }
    return value < 0 ? -choice : choice
  }

  public func script(token: String, seconds: Int?) -> String? {
    guard PageMediaMessage.token(token) != nil else { return nil }
    if self == .skip, seconds == nil { return nil }
    let argument = self == .skip || self == .keepPlaying ? String(seconds ?? 0) : "0"
    return "window.\(PageMediaScript.commandName) && window.\(PageMediaScript.commandName)(\"\(token)\", \"\(rawValue)\", \(argument)); true"
  }
}

public struct PictureInPictureReturn: Sendable {
  public static let window: TimeInterval = 1.5

  private var ended: (pageID: String, at: TimeInterval)?
  private var activeSince: TimeInterval?
  private var inFront = true

  public init() {}

  public mutating func resignedActive() {
    inFront = false
    activeSince = nil
  }

  public mutating func becameActive(at now: TimeInterval) -> String? {
    inFront = true
    activeSince = now
    guard let ended, now - ended.at <= Self.window else { return nil }
    self.ended = nil
    return ended.pageID
  }

  public mutating func pictureInPictureEnded(_ pageID: String, at now: TimeInterval) -> String? {
    if inFront, let activeSince, now - activeSince <= Self.window {
      ended = nil
      return pageID
    }
    ended = (pageID, now)
    return nil
  }

  public mutating func playedOnAfterEnding(_ pageID: String, at now: TimeInterval) -> String? {
    guard inFront, let ended, ended.pageID == pageID, now - ended.at <= Self.window else { return nil }
    self.ended = nil
    return pageID
  }

  public mutating func forget(_ pageID: String) {
    if ended?.pageID == pageID { ended = nil }
  }
}

public struct PageMediaSettings: Equatable, Sendable {
  public var automaticPictureInPicture = true
  public var keepsPlaying = true
  public var skipSeconds = PageMediaCommand.standardSkip

  public init(automaticPictureInPicture: Bool = true, keepsPlaying: Bool = true, skipSeconds: Int = PageMediaCommand.standardSkip) {
    self.automaticPictureInPicture = automaticPictureInPicture
    self.keepsPlaying = keepsPlaying
    self.skipSeconds = PageMediaCommand.skipChoices.contains(skipSeconds) ? skipSeconds : PageMediaCommand.standardSkip
  }
}

public enum PageMediaScript {
  public static let handlerName = "ardiaMedia"
  public static let commandName = "__ardiaMediaCommand"
  static let keepsPlayingPlaceholder = "__ARDIA_MEDIA_KEEPS_PLAYING__"

  public static func source(keepsPlaying: Bool) -> String {
    body.replacingOccurrences(of: keepsPlayingPlaceholder, with: keepsPlaying ? "true" : "false")
  }

  static let body = #"""
  (() => {
    const COMMAND = "__ardiaMediaCommand";
    if (Object.prototype.hasOwnProperty.call(window, COMMAND)) return;
    const handlers = window.webkit && window.webkit.messageHandlers;
    const channel = handlers && handlers.ardiaMedia;
    if (!channel) return;
    const postMessage = channel.postMessage.bind(channel);
    const stringify = JSON.stringify;
    const send = (body) => { try { postMessage(body); } catch (_) {} };
    const token = (Math.random().toString(36) + "0000000000").slice(2, 12);
    const Media = window.HTMLMediaElement;
    if (!Media) return;
    const own = (proto, name) => { try { return Object.getOwnPropertyDescriptor(proto, name); } catch (_) { return undefined; } };
    const docProto = Document.prototype;
    const visibility = own(docProto, "visibilityState");
    const hiddenDesc = own(docProto, "hidden");
    const webkitVisibility = own(docProto, "webkitVisibilityState");
    const webkitHidden = own(docProto, "webkitHidden");
    const reallyHidden = () => { try { return hiddenDesc ? hiddenDesc.get.call(document) === true : false; } catch (_) { return false; } };
    const elementPaused = own(Media.prototype, "paused");
    const elementEnded = own(Media.prototype, "ended");
    const elementMuted = own(Media.prototype, "muted");
    const elementVolume = own(Media.prototype, "volume");
    const elementTime = own(Media.prototype, "currentTime");
    const elementDuration = own(Media.prototype, "duration");
    const elementRate = own(Media.prototype, "playbackRate");
    const originalPlay = Media.prototype.play;
    const originalPause = Media.prototype.pause;
    const read = (descriptor, element, fallback) => { try { return descriptor ? descriptor.get.call(element) : fallback; } catch (_) { return fallback; } };
    const isPaused = (element) => read(elementPaused, element, true) !== false;
    const isEnded = (element) => read(elementEnded, element, false) === true;
    const isPlaying = (element) => !!element && !isPaused(element) && !isEnded(element);
    let keepsPlaying = __ARDIA_MEDIA_KEEPS_PLAYING__;
    const PAUSED_HOLD_MS = 600000;
    let held = false;
    let leaving = null;
    let plays = 0;
    let current = null;
    const wired = new WeakMap();
    const heard = new WeakSet();
    const actions = new Map();
    let lastSent = "";
    let scheduled = false;

    const hasAudio = (element) => {
      if (read(elementMuted, element, true) || Number(read(elementVolume, element, 0)) <= 0) return false;
      if (typeof element.webkitAudioDecodedByteCount === "number" && element.webkitAudioDecodedByteCount > 0) return true;
      if (element.audioTracks && element.audioTracks.length > 0) return true;
      return !(element instanceof HTMLVideoElement);
    };
    const sessionSaysPlaying = () => { try { return navigator.mediaSession && navigator.mediaSession.playbackState !== "none"; } catch (_) { return false; } };
    const longEnough = (element) => {
      const duration = Number(read(elementDuration, element, 0));
      return duration === Infinity || duration > 5 || sessionSaysPlaying();
    };
    const attached = (element) => !(element instanceof HTMLVideoElement) || element.isConnected !== false;
    const controllable = (element) => !!element && attached(element) && heard.has(element) && longEnough(element);

    const pick = () => {
      if (current && !controllable(current)) current = null;
      return current;
    };

    const metadata = () => {
      try {
        const data = navigator.mediaSession && navigator.mediaSession.metadata;
        if (!data) return { title: "", artist: "", artwork: "" };
        const art = Array.prototype.slice.call(data.artwork || [], 0, 12).map((item) => {
          const size = String(item && item.sizes || "").split(/\s+/).map((one) => parseInt(one, 10) || 0).reduce((a, b) => Math.max(a, b), 0);
          let src = "";
          try { src = new URL(String(item && item.src || ""), document.baseURI).href; } catch (_) {}
          return { src, size };
        }).filter((item) => item.src.startsWith("https:"));
        art.sort((a, b) => Math.abs(a.size - 192) - Math.abs(b.size - 192));
        return { title: String(data.title || "").slice(0, 400), artist: String(data.artist || "").slice(0, 400), artwork: art.length ? art[0].src.slice(0, 2048) : "" };
      } catch (_) {
        return { title: "", artist: "", artwork: "" };
      }
    };

    const inPictureInPicture = (element) => {
      try {
        if (element.webkitPresentationMode === "picture-in-picture") return true;
        return document.pictureInPictureElement === element;
      } catch (_) { return false; }
    };
    const canPictureInPicture = (element) => {
      if (!(element instanceof HTMLVideoElement) || !(element.videoWidth > 0)) return false;
      try {
        if (typeof element.webkitSupportsPresentationMode === "function") return element.webkitSupportsPresentationMode("picture-in-picture");
        return document.pictureInPictureEnabled === true;
      } catch (_) { return false; }
    };

    const report = () => {
      scheduled = false;
      const element = pick();
      const body = { type: "media", token, state: "none", plays };
      if (element) {
        const meta = metadata();
        const duration = Number(read(elementDuration, element, 0));
        body.state = isPlaying(element) ? "playing" : "paused";
        body.hasVideo = element instanceof HTMLVideoElement && element.videoWidth > 0;
        body.title = meta.title;
        body.artist = meta.artist;
        body.artwork = meta.artwork;
        body.duration = isFinite(duration) && duration > 0 ? duration : 0;
        body.position = Number(read(elementTime, element, 0)) || 0;
        body.rate = Number(read(elementRate, element, 1)) || 0;
        body.canPrevious = actions.has("previoustrack");
        body.canNext = actions.has("nexttrack");
        body.canPictureInPicture = canPictureInPicture(element);
        body.inPictureInPicture = inPictureInPicture(element);
        body.isFullscreen = element.webkitDisplayingFullscreen === true;
      }
      const rounded = body.position;
      body.position = Math.round(rounded || 0);
      const key = stringify(body);
      body.position = rounded || 0;
      if (key === lastSent) return;
      lastSent = key;
      send(body);
    };
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      setTimeout(report, 0);
    };

    const release = () => {
      if (!held) return;
      held = false;
      if (reallyHidden()) document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
    };

    const resume = (element, why) => {
      if (!element || !isPaused(element) || !leaving || leaving.element !== element || leaving.resumed) return;
      leaving.resumed = true;
      let answer;
      try { answer = originalPlay.call(element); } catch (_) { answer = null; }
      if (answer && typeof answer.then === "function") {
        answer.then(() => send({ type: "left", token, outcome: "resumed" }), () => send({ type: "left", token, outcome: "refused" }));
      } else if (answer === null) {
        send({ type: "left", token, outcome: "refused" });
      }
    };

    const becameCurrent = (element) => {
      if (current !== element) plays += 1;
      current = element;
    };
    const listenForSound = (element) => {
      [600, 1500, 3500].forEach((delay) => setTimeout(() => {
        if (heard.has(element) || !isPlaying(element) || !hasAudio(element)) return;
        heard.add(element);
        becameCurrent(element);
        schedule();
      }, delay));
    };
    const listen = (element) => {
      const known = wired.get(element);
      if (known) return known;
      const changed = (event) => {
        const kind = event.type;
        if (kind === "playing" || kind === "play") {
          if (hasAudio(element)) heard.add(element);
          else if (kind === "playing") listenForSound(element);
          if (kind === "playing" && heard.has(element)) {
            if (current === element && lastSent.indexOf('"state":"paused"') >= 0) plays += 1;
            becameCurrent(element);
          }
        } else if (kind === "volumechange" && isPlaying(element) && hasAudio(element)) {
          heard.add(element);
          becameCurrent(element);
        } else if (kind === "pause" && leaving && leaving.element === element && Date.now() < leaving.until) {
          setTimeout(() => resume(element, "pause"), 250);
        } else if (kind === "ended" && element === current && held) {
          setTimeout(() => { if (held && element === current && isEnded(element)) release(); }, 1000);
        } else if (kind === "pause" && element === current && held && !(leaving && Date.now() < leaving.until)) {
          const pausedAt = plays;
          setTimeout(() => { if (held && element === current && plays === pausedAt && isPaused(element)) release(); }, PAUSED_HOLD_MS);
        } else if (kind === "emptied" && element === current && !element.currentSrc) {
          current = null;
        }
        schedule();
      };
      wired.set(element, changed);
      ["play", "playing", "pause", "ended", "emptied", "durationchange", "loadedmetadata", "volumechange", "ratechange", "seeked", "resize", "enterpictureinpicture", "leavepictureinpicture", "webkitpresentationmodechanged", "webkitbeginfullscreen", "webkitendfullscreen"].forEach((name) => element.addEventListener(name, changed, { passive: true }));
      return null;
    };
    ["play", "playing", "volumechange", "loadedmetadata"].forEach((name) => document.addEventListener(name, (event) => {
      const target = event.target;
      if (!(target instanceof Media) || wired.has(target)) return;
      listen(target);
      const changed = wired.get(target);
      if (changed) changed({ type: name });
    }, { capture: true, passive: true }));
    Media.prototype.play = function () {
      if (this instanceof Media) listen(this);
      return originalPlay.apply(this, arguments);
    };

    const session = window.MediaSession && window.MediaSession.prototype;
    if (session) {
      const setAction = session.setActionHandler;
      if (typeof setAction === "function") {
        session.setActionHandler = function (action, handler) {
          const answer = setAction.apply(this, arguments);
          if (this === navigator.mediaSession) {
            if (typeof handler === "function") actions.set(String(action), handler);
            else actions.delete(String(action));
            schedule();
          }
          return answer;
        };
      }
      ["metadata", "playbackState"].forEach((name) => {
        const descriptor = own(session, name);
        if (!descriptor || !descriptor.set || !descriptor.configurable) return;
        Object.defineProperty(session, name, {
          configurable: true,
          enumerable: descriptor.enumerable,
          get() { return descriptor.get.call(this); },
          set(value) { descriptor.set.call(this, value); schedule(); },
        });
      });
    }

    const shownAs = (descriptor, visible) => descriptor && descriptor.get && descriptor.configurable && {
      configurable: true,
      enumerable: descriptor.enumerable,
      get() { return held && this === document ? visible : descriptor.get.call(this); },
    };
    [["visibilityState", visibility, "visible"], ["hidden", hiddenDesc, false], ["webkitVisibilityState", webkitVisibility, "visible"], ["webkitHidden", webkitHidden, false]].forEach(([name, descriptor, visible]) => {
      const replacement = shownAs(descriptor, visible);
      if (replacement) Object.defineProperty(docProto, name, replacement);
    });
    const playingOrLeaving = () => {
      const element = pick();
      if (isPlaying(element)) return true;
      return !!(leaving && leaving.element === element && Date.now() < leaving.until);
    };
    const onVisibility = (event) => {
      if (event.target !== document) return;
      if (reallyHidden()) {
        if (!held && keepsPlaying && playingOrLeaving()) {
          held = true;
          event.stopImmediatePropagation();
          send({ type: "left", token, outcome: "held" });
          if (leaving && isPaused(leaving.element)) setTimeout(() => resume(leaving && leaving.element, "hidden"), 250);
        } else if (held) {
          event.stopImmediatePropagation();
        }
      } else if (held) {
        held = false;
        event.stopImmediatePropagation();
      }
    };
    window.addEventListener("visibilitychange", onVisibility, true);
    window.addEventListener("pagehide", () => { held = false; leaving = null; lastSent = ""; send({ type: "media", token, state: "none", plays }); }, true);
    window.addEventListener("pageshow", (event) => { if (event.persisted) schedule(); }, true);
    window.addEventListener("webkitvisibilitychange", (event) => { if (held) event.stopImmediatePropagation(); }, true);

    const command = (from, name, seconds) => {
      if (from !== token) return false;
      const element = pick();
      switch (name) {
        case "leave": {
          const playing = isPlaying(element);
          leaving = playing && keepsPlaying ? { element, until: Date.now() + 4000, resumed: false } : null;
          lastSent = "";
          schedule();
          return playing;
        }
        case "returned":
          leaving = null;
          if (held && !reallyHidden()) held = false;
          lastSent = "";
          schedule();
          return true;
        case "keepPlaying":
          keepsPlaying = Number(seconds) === 1;
          if (!keepsPlaying) { leaving = null; release(); }
          return true;
        case "previous":
        case "next": {
          const handler = actions.get(name === "previous" ? "previoustrack" : "nexttrack");
          if (!handler) return false;
          try { handler.call(navigator.mediaSession, { action: name === "previous" ? "previoustrack" : "nexttrack" }); } catch (_) {}
          return true;
        }
      }
      if (!element) return false;
      switch (name) {
        case "play":
          try { originalPlay.call(element); } catch (_) {}
          return true;
        case "pause":
          leaving = null;
          try { originalPause.call(element); } catch (_) {}
          return true;
        case "skip": {
          const step = Number(seconds);
          if (!isFinite(step) || Math.abs(step) > 30) return false;
          const duration = Number(read(elementDuration, element, 0));
          const now = Number(read(elementTime, element, 0)) || 0;
          const target = Math.max(0, isFinite(duration) && duration > 0 ? Math.min(duration - 0.25, now + step) : now + step);
          try { elementTime.set.call(element, target); } catch (_) {}
          schedule();
          return true;
        }
        case "pictureInPicture":
          try {
            if (typeof element.webkitSetPresentationMode === "function" && element.webkitSupportsPresentationMode("picture-in-picture")) element.webkitSetPresentationMode("picture-in-picture");
            else if (typeof element.requestPictureInPicture === "function") element.requestPictureInPicture().catch(() => schedule());
            else return false;
          } catch (_) { return false; }
          return true;
        case "leavePictureInPicture":
          try {
            if (element.webkitPresentationMode === "picture-in-picture") element.webkitSetPresentationMode("inline");
            else if (document.pictureInPictureElement && typeof document.exitPictureInPicture === "function") document.exitPictureInPicture().catch(() => {});
          } catch (_) {}
          return true;
      }
      return false;
    };
    Object.defineProperty(window, COMMAND, { value: command, configurable: false, enumerable: false, writable: false });
  })();
  """#
}
