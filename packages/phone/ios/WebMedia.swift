import ArdiaBrowser
import AVKit
import UIKit
import WebKit

@MainActor
final class WebMedia {
  enum Outcome: String {
    case floated
    case keptPlaying
    case playingInBackground
    case resumeRefused
    case pausedOnLeaving
    case pictureInPictureStarted
    case pictureInPictureRefused
    case returnedToTab
  }

  struct Frame {
    var report: PageMediaReport
    var frame: WKFrameInfo
    var updatedAt: TimeInterval
    var startedAt: TimeInterval
    var startedWallMs: Double
    var pausedAt: TimeInterval?
  }

  struct KnownFrame {
    var frame: WKFrameInfo
    var at: TimeInterval
  }

  static let keptPlayingCheck: TimeInterval = 5
  static let playbackAnswerLimit: TimeInterval = 1
  static let pictureInPictureAnswerLimit: TimeInterval = 1.5
  static let framesPerPage = 8
  static let knownFramesPerPage = 16
  static let defaultsKey = "media.settings"

  private(set) var settings: PageMediaSettings
  private var frames: [String: [String: Frame]] = [:]
  private var known: [String: [String: KnownFrame]] = [:]
  private var retentionCheck = 0
  private var answeredSince: [String: TimeInterval] = [:]
  static let answerWindow: TimeInterval = 3
  private var sent: [String: Sent] = [:]

  struct Sent: Equatable {
    var report: PageMediaReport?
    var startedAt: TimeInterval
    var isPrivate: Bool
  }
  private var returning = PictureInPictureReturn()
  private var observers: [NSObjectProtocol] = []
  private var departure = 0
  private var inBackground = false
  private var leftWhilePlaying = false
  private var automatic: (pageID: String, token: String, departure: Int)?
  private let defaults: UserDefaults
  private let host: Host

  struct Host {
    var pageID: @MainActor (WKWebView?) -> String?
    var webView: @MainActor (String) -> WKWebView?
    var isPrivate: @MainActor (String) -> Bool
    var anyPrivateTab: @MainActor () -> Bool
    var liveWebViews: @MainActor () -> [WKWebView]
    var keepLive: @MainActor (_ audible: [String], _ paused: [String]) -> Void
    var send: @MainActor ([String: Any?]) -> Void
    var installScripts: @MainActor ([WKUserScript]) -> Void
  }

  init(defaults: UserDefaults, host: Host) {
    self.defaults = defaults
    self.host = host
    settings = Self.storedSettings(defaults)
    host.installScripts(scripts)
    let center = NotificationCenter.default
    observers.append(center.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.willLeave() }
    })
    observers.append(center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.left() }
    })
    observers.append(center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.cameBack() }
    })
  }

  var scripts: [WKUserScript] {
    [WKUserScript(source: PageMediaScript.source(keepsPlaying: settings.keepsPlaying), injectionTime: .atDocumentStart, forMainFrameOnly: false, in: .page)]
  }

  func attach(to controller: WKUserContentController) {
    controller.add(WebMediaMessages(media: self), contentWorld: .page, name: PageMediaScript.handlerName)
  }

  static func storedSettings(_ defaults: UserDefaults) -> PageMediaSettings {
    guard let stored = defaults.dictionary(forKey: defaultsKey) else { return PageMediaSettings() }
    return PageMediaSettings(
      automaticPictureInPicture: stored["automaticPictureInPicture"] as? Bool ?? true,
      keepsPlaying: stored["keepsPlaying"] as? Bool ?? true,
      skipSeconds: stored["skipSeconds"] as? Int ?? PageMediaCommand.standardSkip
    )
  }

  func apply(_ next: PageMediaSettings) {
    let keepsPlayingChanged = next.keepsPlaying != settings.keepsPlaying
    settings = next
    defaults.set(["automaticPictureInPicture": next.automaticPictureInPicture, "keepsPlaying": next.keepsPlaying, "skipSeconds": next.skipSeconds], forKey: Self.defaultsKey)
    guard keepsPlayingChanged else { return }
    host.installScripts(scripts)
    let tokens = Set(known.flatMap { pageID, pageFrames in pageFrames.keys.map { "\(pageID) \($0)" } }).union(frames.flatMap { pageID, pageFrames in pageFrames.keys.map { "\(pageID) \($0)" } })
    for pair in tokens {
      let parts = pair.split(separator: " ", maxSplits: 1).map(String.init)
      run(.keepPlaying, pageID: parts[0], token: parts[1], seconds: next.keepsPlaying ? 1 : 0)
    }
  }

  static func trace(_ line: String) {
    if PhoneTestBuild.isOn { NSLog("MEDIALAB %@", line) }
  }

  nonisolated static var pictureInPictureSupported: Bool { AVPictureInPictureController.isPictureInPictureSupported() }

  func received(_ body: Any, frame: WKFrameInfo, webView: WKWebView?) {
    guard let pageID = host.pageID(webView), let message = PageMediaMessage.parse(body) else { return }
    switch message {
    case .report(let report):
      take(report, frame: frame, pageID: pageID)
    case .left(_, let outcome):
      Self.trace("left \(pageID) \(outcome.rawValue)")
      if outcome == .refused { report(.resumeRefused, pageID: pageID) }
    case .hello(let token, let keepsPlaying):
      remember(token, frame: frame, pageID: pageID)
      catchUp(token, keepsPlaying: keepsPlaying, pageID: pageID)
    case .gone(let token):
      known[pageID]?[token] = nil
      if known[pageID]?.isEmpty == true { known[pageID] = nil }
    }
  }

  private func remember(_ token: String, frame: WKFrameInfo, pageID: String) {
    var pageFrames = known[pageID] ?? [:]
    pageFrames[token] = KnownFrame(frame: frame, at: ProcessInfo.processInfo.systemUptime)
    if pageFrames.count > Self.knownFramesPerPage, let oldest = pageFrames.min(by: { $0.value.at < $1.value.at })?.key { pageFrames[oldest] = nil }
    known[pageID] = pageFrames
  }

  private func catchUp(_ token: String, keepsPlaying: Bool?, pageID: String) {
    guard let keepsPlaying, keepsPlaying != settings.keepsPlaying else { return }
    Self.trace("catchUp \(pageID) \(token) keepsPlaying=\(settings.keepsPlaying)")
    run(.keepPlaying, pageID: pageID, token: token, seconds: settings.keepsPlaying ? 1 : 0)
  }

  private func take(_ report: PageMediaReport, frame: WKFrameInfo, pageID: String) {
    Self.trace("report \(pageID) \(report.token) \(report.state.rawValue) t=\(String(format: "%.1f", report.position)) video=\(report.hasVideo) pip=\(report.inPictureInPicture) main=\(frame.isMainFrame) app=\(UIApplication.shared.applicationState.rawValue)")
    let now = ProcessInfo.processInfo.systemUptime
    let before = best(pageID)
    remember(report.token, frame: frame, pageID: pageID)
    catchUp(report.token, keepsPlaying: report.keepsPlaying, pageID: pageID)
    var pageFrames = frames[pageID] ?? [:]
    let previous = pageFrames[report.token]
    let started = report.state == .playing && (previous.map { $0.report.plays < report.plays } ?? true)
    if report.state == .none {
      pageFrames[report.token] = nil
    } else {
      let wallMs = (Date().timeIntervalSince1970 * 1000).rounded()
      let pausedAt = report.state == .playing ? nil : (previous?.report.state == report.state ? previous?.pausedAt : nil) ?? now
      pageFrames[report.token] = Frame(report: report, frame: frame, updatedAt: now, startedAt: started ? now : previous?.startedAt ?? now, startedWallMs: started ? wallMs : previous?.startedWallMs ?? wallMs, pausedAt: pausedAt)
    }
    if pageFrames.count > Self.framesPerPage, let oldest = pageFrames.min(by: { $0.value.updatedAt < $1.value.updatedAt })?.key { pageFrames[oldest] = nil }
    frames[pageID] = pageFrames.isEmpty ? nil : pageFrames
    let after = best(pageID)
    if before?.report.inPictureInPicture == true, after?.report.inPictureInPicture != true, let returnTo = returning.pictureInPictureEnded(pageID, at: now) {
      returnToTab(returnTo)
    } else if after?.report.state == .playing, after?.report.inPictureInPicture == false, let returnTo = returning.playedOnAfterEnding(pageID, at: now) {
      returnToTab(returnTo)
    }
    publish(pageID)
  }

  func best(_ pageID: String) -> Frame? {
    frames[pageID]?.values.max { a, b in
      let aPlaying = a.report.state == .playing, bPlaying = b.report.state == .playing
      if aPlaying != bPlaying { return !aPlaying }
      return aPlaying ? a.startedAt < b.startedAt : a.updatedAt < b.updatedAt
    }
  }

  private func publish(_ pageID: String) {
    let frame = best(pageID)
    let next = Sent(report: frame?.report, startedAt: frame?.startedAt ?? 0, isPrivate: host.isPrivate(pageID))
    let answersACommand = answeredSince[pageID].map { ProcessInfo.processInfo.systemUptime - $0 < Self.answerWindow } ?? false
    guard sent[pageID] != next || answersACommand, frame != nil || sent[pageID] != nil else { return }
    sent[pageID] = frame == nil ? nil : next
    host.send(payload(pageID))
    keepPlayingPagesLive()
  }

  private func payload(_ pageID: String) -> [String: Any?] {
    guard let frame = best(pageID) else { return ["name": "pages.media", "pageId": pageID, "state": "none", "isPrivate": host.isPrivate(pageID)] }
    let report = frame.report
    return [
      "name": "pages.media",
      "pageId": pageID,
      "state": report.state.rawValue,
      "hasVideo": report.hasVideo,
      "title": report.title,
      "artist": report.artist,
      "artworkUrl": report.artworkURL,
      "duration": report.duration,
      "position": report.position,
      "rate": report.rate,
      "at": Date().timeIntervalSince1970 * 1000,
      "startedAt": frame.startedWallMs,
      "canPrevious": report.canPrevious,
      "canNext": report.canNext,
      "canPictureInPicture": PhoneTestBuild.flag("ArdiaShowPictureInPictureButton") ? report.hasVideo : report.canPictureInPicture && Self.pictureInPictureSupported,
      "inPictureInPicture": report.inPictureInPicture,
      "isPrivate": host.isPrivate(pageID),
    ]
  }

  private func keepPlayingPagesLive() {
    let now = ProcessInfo.processInfo.systemUptime
    let candidates = frames.keys.compactMap { pageID in
      best(pageID).map { frame in
        PageMediaRetention.Candidate(id: pageID, audible: frame.report.state == .playing || frame.report.inPictureInPicture, startedAt: frame.startedAt, pausedAt: frame.pausedAt)
      }
    }
    let kept = PageMediaRetention.kept(candidates, now: now)
    host.keepLive(kept.audible, kept.paused)
    retentionCheck += 1
    guard let expiry = kept.nextExpiry else { return }
    let check = retentionCheck
    Task { @MainActor [weak self] in
      try? await Task.sleep(for: .seconds(max(1, expiry - now + 1)))
      guard let self, self.retentionCheck == check else { return }
      self.keepPlayingPagesLive()
    }
  }

  func forget(_ pageID: String) {
    answeredSince[pageID] = nil
    returning.forget(pageID)
    known[pageID] = nil
    guard frames.removeValue(forKey: pageID) != nil || sent[pageID] != nil else { return }
    sent[pageID] = nil
    host.send(["name": "pages.media", "pageId": pageID, "state": "none", "isPrivate": false])
    keepPlayingPagesLive()
  }

  func pageEnded(_ pageID: String) {
    known[pageID] = nil
    guard frames[pageID] != nil else { return }
    frames[pageID] = nil
    publish(pageID)
  }

  func command(_ pageID: String, _ name: String, seconds: Double?) async -> Bool {
    guard let command = PageMediaCommand(rawValue: name), [.play, .pause, .skip, .previous, .next, .pictureInPicture, .leavePictureInPicture].contains(command), let frame = best(pageID) else { return false }
    if command == .pictureInPicture, !(Self.pictureInPictureSupported && frame.report.hasVideo) { return false }
    let step = command == .skip ? PageMediaCommand.skipSeconds(seconds) : nil
    if command == .skip, step == nil { return false }
    guard let (webView, frameInfo, script) = prepare(command, pageID: pageID, token: frame.report.token, seconds: step) else { return false }
    answeredSince[pageID] = ProcessInfo.processInfo.systemUptime
    let answer = try? await webView.evaluateJavaScript(script, in: frameInfo, contentWorld: .page)
    let accepted = answer as? Bool == true
    Self.trace("answer \(pageID) \(command.rawValue) \(accepted)")
    return accepted
  }

  private func prepare(_ command: PageMediaCommand, pageID: String, token: String, seconds: Int?) -> (WKWebView, WKFrameInfo, String)? {
    Self.trace("command \(pageID) \(token) \(command.rawValue) \(seconds.map(String.init) ?? "")")
    guard let frame = frames[pageID]?[token]?.frame ?? known[pageID]?[token]?.frame, let webView = host.webView(pageID), let script = command.script(token: token, seconds: seconds) else { return nil }
    return (webView, frame, script)
  }

  @discardableResult
  private func run(_ command: PageMediaCommand, pageID: String, token: String, seconds: Int?) -> Bool {
    guard let (webView, frame, script) = prepare(command, pageID: pageID, token: token, seconds: seconds) else { return false }
    webView.evaluateJavaScript(script, in: frame, in: .page) { _ in }
    return true
  }

  private func willLeave() {
    departure += 1
    returning.resignedActive()
    let playing = frames.flatMap { pageID, pageFrames in pageFrames.values.filter { $0.report.state == .playing }.map { (pageID, $0) } }
    leftWhilePlaying = !playing.isEmpty
    automatic = nil
    let floating = settings.automaticPictureInPicture && Self.pictureInPictureSupported && !WebVideoFloat.isPresentingWebVideo
      ? playing.filter({ $0.1.report.hasVideo && $0.1.report.canPictureInPicture && !$0.1.report.inPictureInPicture && !$0.1.report.isFullscreen && host.webView($0.0)?.window != nil }).max(by: { $0.1.startedAt < $1.1.startedAt })
      : nil
    if settings.keepsPlaying {
      for (pageID, frame) in playing { run(.leave, pageID: pageID, token: frame.report.token, seconds: nil) }
    } else {
      let departing = playing.map { PageMediaDeparture.Playing(pageID: $0.0, token: $0.1.report.token, inPictureInPicture: $0.1.report.inPictureInPicture, isFullscreen: $0.1.report.isFullscreen) }
      let floatingOne = floating.map { PageMediaDeparture.Playing(pageID: $0.0, token: $0.1.report.token) }
      for one in PageMediaDeparture.pauses(departing, keepsPlaying: false, pictureInPictureSupported: Self.pictureInPictureSupported, floating: floatingOne) where run(.pause, pageID: one.pageID, token: one.token, seconds: nil) {
        report(.pausedOnLeaving, pageID: one.pageID)
      }
    }
    guard let (pageID, frame) = floating else { return }
    guard run(.pictureInPicture, pageID: pageID, token: frame.report.token, seconds: nil) else { return }
    let departed = departure
    automatic = (pageID, frame.report.token, departed)
    Task { @MainActor [weak self] in
      try? await Task.sleep(for: .seconds(Self.pictureInPictureAnswerLimit))
      guard let self, let automatic = self.automatic, automatic.departure == departed else { return }
      let started = self.frames[automatic.pageID]?[automatic.token]?.report.inPictureInPicture == true
      self.report(started ? .pictureInPictureStarted : .pictureInPictureRefused, pageID: automatic.pageID)
    }
  }

  private func left() {
    inBackground = true
    let departed = departure
    let floated = WebVideoFloat.isPresentingWebVideo || frames.values.contains { $0.values.contains { $0.report.inPictureInPicture } }
    if floated { report(.floated, pageID: nil) }
    guard floated || leftWhilePlaying else { return }
    Task { @MainActor [weak self] in
      try? await Task.sleep(for: .seconds(Self.keptPlayingCheck))
      guard let self, self.departure == departed, UIApplication.shared.applicationState == .background,
            await Self.anyPlaying(self.host.liveWebViews()),
            self.departure == departed, UIApplication.shared.applicationState == .background,
            self.frames.values.contains(where: { $0.values.contains { $0.report.state == .playing } }) else { return }
      self.report(floated ? .keptPlaying : .playingInBackground, pageID: nil)
    }
  }

  private func cameBack() {
    inBackground = false
    let now = ProcessInfo.processInfo.systemUptime
    for (pageID, pageFrames) in frames {
      for token in pageFrames.keys { run(.returned, pageID: pageID, token: token, seconds: nil) }
    }
    if let returnTo = returning.becameActive(at: now) { returnToTab(returnTo) }
    if let automatic, frames[automatic.pageID]?[automatic.token]?.report.inPictureInPicture == true {
      run(.leavePictureInPicture, pageID: automatic.pageID, token: automatic.token, seconds: nil)
    }
    automatic = nil
  }

  private func returnToTab(_ pageID: String) {
    report(.returnedToTab, pageID: pageID)
    host.send(["name": "pages.mediaReturn", "pageId": pageID])
  }

  private func report(_ outcome: Outcome, pageID: String?) {
    let isPrivate = pageID.map(host.isPrivate) ?? (host.anyPrivateTab() || frames.keys.contains(where: host.isPrivate))
    Self.trace("outcome \(outcome.rawValue) page=\(pageID ?? "none") private=\(isPrivate)")
    host.send(["name": "pages.webVideo", "outcome": outcome.rawValue, "isPrivate": isPrivate])
  }

  private static func anyPlaying(_ webViews: [WKWebView]) async -> Bool {
    for webView in webViews where await isPlaying(webView) { return true }
    return false
  }

  private static func isPlaying(_ webView: WKWebView) async -> Bool {
    await withCheckedContinuation { continuation in
      let answer = FirstAnswer(continuation)
      webView.requestMediaPlaybackState { state in
        MainActor.assumeIsolated { answer.give(state == .playing) }
      }
      DispatchQueue.main.asyncAfter(deadline: .now() + playbackAnswerLimit) {
        MainActor.assumeIsolated { answer.give(false) }
      }
    }
  }
}

@MainActor
final class WebMediaMessages: NSObject, WKScriptMessageHandler {
  weak var media: WebMedia?

  init(media: WebMedia) {
    self.media = media
  }

  func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
    media?.received(message.body, frame: message.frameInfo, webView: message.webView)
  }
}

@MainActor
enum WebVideoFloat {
  static var isPresentingWebVideo: Bool {
    UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap(\.windows)
      .contains { window in
        !window.isHidden && window.rootViewController?.children.contains { $0 is AVPlayerViewController } == true
      }
  }
}

@MainActor
private final class FirstAnswer: Sendable {
  private var continuation: CheckedContinuation<Bool, Never>?

  init(_ continuation: CheckedContinuation<Bool, Never>) {
    self.continuation = continuation
  }

  func give(_ playing: Bool) {
    continuation?.resume(returning: playing)
    continuation = nil
  }
}

extension PhonePages {
  func liveWebViews() -> [WKWebView] {
    tabIDs.values.compactMap(engine.existingWebTab).compactMap(\.webView)
  }

  func pageID(of webView: WKWebView?) -> String? {
    guard let webView else { return nil }
    return tabIDs.first { engine.existingWebTab($0.value)?.webView === webView }?.key
  }

  func isPrivatePage(_ pageID: String) -> Bool {
    tabIDs[pageID].map(engine.tabs.isPrivate) ?? false
  }

  func makeMedia() -> WebMedia {
    WebMedia(defaults: defaults, host: WebMedia.Host(
      pageID: { [weak self] webView in self?.pageID(of: webView) },
      webView: { [weak self] pageID in self?.page(pageID)?.webView },
      isPrivate: { [weak self] pageID in self?.isPrivatePage(pageID) ?? false },
      anyPrivateTab: { [weak self] in !(self?.engine.tabs.privateTabs.isEmpty ?? true) },
      liveWebViews: { [weak self] in self?.liveWebViews() ?? [] },
      keepLive: { [weak self] audible, paused in
        guard let self else { return }
        self.engine.keepsLive = Set(audible.compactMap { self.tabIDs[$0] })
        self.engine.keepsLiveWhileMemoryAllows = Set(paused.compactMap { self.tabIDs[$0] })
      },
      send: { [weak self] event in self?.pageSink?(event) },
      installScripts: { [weak self] scripts in self?.engine.setExtraPageScripts(scripts) }
    ))
  }
}
