import Foundation
import Testing
import WebKit
@testable import ArdiaBrowser

struct PageMediaReportTests {
  static var playing: [String: Any] { [
    "type": "media", "token": "abc123def0", "state": "playing", "hasVideo": true, "title": "Song", "artist": "Band",
    "artwork": "https://img.example.com/a.png", "duration": 200.5, "position": 12.25, "rate": 1, "canPrevious": false,
    "canNext": true, "canPictureInPicture": true, "inPictureInPicture": false, "isFullscreen": false, "plays": 2,
  ] }

  static let hostileTexts: [String] = [
    "\n", "\r", "\r\n", "\u{0C}", "\u{0B}", "\u{85}", "\u{2028}", "\u{2029}", "\u{0}", "\t", "\u{1F}", "\u{7F}", "\u{FEFF}",
    "\u{200B}", "\u{202E}", "\u{AD}", "\u{FFFD}", String(repeating: "x", count: 100_000), "javascript:alert(1)", "../../etc/passwd",
    "__proto__", "constructor", "<script>alert(1)</script>",
  ]

  @Test func readsAPlayingReport() throws {
    let report = try #require(PageMediaReport.parse(Self.playing))
    #expect(report.state == .playing)
    #expect(report.title == "Song")
    #expect(report.artworkURL == "https://img.example.com/a.png")
    #expect(report.duration == 200.5)
    #expect(report.position == 12.25)
    #expect(report.canNext && !report.canPrevious)
    #expect(report.plays == 2)
  }

  @Test func refusesReportsWithoutAKnownShape() {
    #expect(PageMediaReport.parse(nil) == nil)
    #expect(PageMediaReport.parse("media") == nil)
    #expect(PageMediaReport.parse(["type": "media", "token": "abc123def0", "state": "loud"]) == nil)
    #expect(PageMediaReport.parse(["type": "other", "token": "abc123def0", "state": "playing"]) == nil)
    for token: Any in ["", "ABC123DEF0", "abc", "abc123def0abc123def0", "abc 123def", "abc123def\n", 12345678, ["abc123def0"]] {
      #expect(PageMediaReport.parse(["type": "media", "token": token, "state": "playing"]) == nil)
    }
  }

  @Test func titlesComeOutAsOneShortCleanLine() {
    for hostile in Self.hostileTexts {
      for wrapped in [hostile, "A\(hostile)B", "\(hostile)\(hostile)"] {
        let text = PageMediaReport.cleanText(wrapped)
        #expect(text.count <= PageMediaReport.longestText)
        #expect(!text.unicodeScalars.contains { [.control, .format, .lineSeparator, .paragraphSeparator, .surrogate].contains($0.properties.generalCategory) && $0.value != 0x200D })
        #expect(!text.hasPrefix(" ") && !text.hasSuffix(" "))
        #expect(!text.contains("  "))
      }
    }
    #expect(PageMediaReport.cleanText("Line one\nLine two") == "Line one Line two")
    #expect(PageMediaReport.cleanText("Family 👨‍👩‍👧 song") == "Family 👨‍👩‍👧 song")
    #expect(PageMediaReport.cleanText(42) == "")
    #expect(PageMediaReport.cleanText(["title"]) == "")
  }

  @Test func artworkIsOnlyAPlainSecureAddress() {
    #expect(PageMediaReport.artwork("https://i.ytimg.com/vi/x/hq.jpg") == "https://i.ytimg.com/vi/x/hq.jpg")
    let refused: [Any] = [
      "http://img.example.com/a.png", "javascript:alert(1)", "data:image/png;base64,AAAA", "file:///etc/passwd", "ardia://open?url=x",
      "https://user:pass@img.example.com/a.png", "https:///a.png", "https://img.example.com/a b.png", "https://img.example.com/a\n.png",
      "https://img.example.com/\u{202E}gnp.a", "https://ímg.example.com/a.png", "https://img.example.com/" + String(repeating: "a", count: 3000), 42, "",
    ]
    for value in refused { #expect(PageMediaReport.artwork(value) == nil) }
  }

  @Test func numbersAreClampedAndBooleansMustBeBooleans() throws {
    var fields = Self.playing
    fields["duration"] = Double.infinity
    fields["position"] = -5
    fields["rate"] = 1000
    fields["plays"] = 1e12
    fields["hasVideo"] = 1
    fields["canNext"] = "true"
    let report = try #require(PageMediaReport.parse(fields))
    #expect(report.duration == nil)
    #expect(report.position == 0)
    #expect(report.rate == PageMediaReport.fastestRate)
    #expect(report.plays == PageMediaReport.mostPlays)
    #expect(!report.hasVideo)
    #expect(!report.canNext)
    fields["duration"] = 100
    fields["position"] = 500
    #expect(try #require(PageMediaReport.parse(fields)).position == 100)
    fields["duration"] = true
    #expect(try #require(PageMediaReport.parse(fields)).duration == nil)
  }

  @Test func framesAnnounceThemselvesAndLeaveWithTheirToken() {
    #expect(PageMediaMessage.parse(["type": "hello", "token": "abc123def0"]) == .hello(token: "abc123def0", keepsPlaying: nil))
    #expect(PageMediaMessage.parse(["type": "hello", "token": "abc123def0", "keepsPlaying": false]) == .hello(token: "abc123def0", keepsPlaying: false))
    #expect(PageMediaMessage.parse(["type": "hello", "token": "abc123def0", "keepsPlaying": 1]) == .hello(token: "abc123def0", keepsPlaying: nil))
    #expect(PageMediaReport.parse(["type": "media", "token": "abc123def0", "state": "none", "keepsPlaying": true])?.keepsPlaying == true)
    #expect(PageMediaReport.parse(["type": "media", "token": "abc123def0", "state": "none", "keepsPlaying": "yes"])?.keepsPlaying == nil)
    #expect(PageMediaMessage.parse(["type": "gone", "token": "abc123def0"]) == .gone(token: "abc123def0"))
    #expect(PageMediaMessage.parse(["type": "hello", "token": "ABC"]) == nil)
    #expect(PageMediaMessage.parse(["type": "hello"]) == nil)
  }

  @Test func leaveOutcomesNeedAKnownOutcome() {
    #expect(PageMediaMessage.parse(["type": "left", "token": "abc123def0", "outcome": "resumed"]) == .left(token: "abc123def0", outcome: .resumed))
    #expect(PageMediaMessage.parse(["type": "left", "token": "abc123def0", "outcome": "stolen"]) == nil)
    #expect(PageMediaMessage.parse(["type": "left", "token": "x", "outcome": "held"]) == nil)
  }
}

struct PageMediaCommandTests {
  @Test func skipsOnlyByTheOfferedLengths() {
    #expect(PageMediaCommand.skipSeconds(15) == 15)
    #expect(PageMediaCommand.skipSeconds(-30) == -30)
    #expect(PageMediaCommand.skipSeconds(12) == nil)
    #expect(PageMediaCommand.skipSeconds(.nan) == nil)
    #expect(PageMediaCommand.skipSeconds(nil) == nil)
    for extreme in [1e100, -1e100, Double.greatestFiniteMagnitude, -Double.greatestFiniteMagnitude, 9.3e18, -9.3e18, Double.leastNonzeroMagnitude, 15.4, 15.6, -0.0, .infinity, -.infinity] {
      #expect(PageMediaCommand.skipSeconds(extreme) == nil)
    }
    #expect(PageMediaCommand.skipSeconds(15.0) == 15)
    #expect(PageMediaCommand.skipSeconds(-10) == -10)
  }

  @Test func commandScriptsCarryOnlyACheckedTokenAndANumber() throws {
    let script = try #require(PageMediaCommand.skip.script(token: "abc123def0", seconds: -10))
    #expect(script.contains("(\"abc123def0\", \"skip\", -10)"))
    #expect(PageMediaCommand.skip.script(token: "abc123def0", seconds: nil) == nil)
    #expect(PageMediaCommand.play.script(token: "abc\"); alert(1); (\"", seconds: nil) == nil)
    #expect(try #require(PageMediaCommand.keepPlaying.script(token: "abc123def0", seconds: 1)).contains("\"keepPlaying\", 1)"))
    #expect(script.hasSuffix("=== true"))
  }

  @Test func settingsKeepTheSkipLengthToAChoice() {
    #expect(PageMediaSettings(skipSeconds: 30).skipSeconds == 30)
    #expect(PageMediaSettings(skipSeconds: 7).skipSeconds == PageMediaCommand.standardSkip)
  }
}

struct PictureInPictureReturnTests {
  @Test func theRestoreButtonBringsTheTabBack() {
    var rule = PictureInPictureReturn()
    rule.resignedActive()
    #expect(rule.pictureInPictureEnded("tab", at: 100) == nil)
    #expect(rule.becameActive(at: 100.6) == "tab")
  }

  @Test func activatingFirstThenEndingAlsoReturns() {
    var rule = PictureInPictureReturn()
    rule.resignedActive()
    #expect(rule.becameActive(at: 50) == nil)
    #expect(rule.pictureInPictureEnded("tab", at: 50.4) == "tab")
  }

  @Test func closingThePictureInPictureInTheBackgroundStaysAway() {
    var rule = PictureInPictureReturn()
    rule.resignedActive()
    #expect(rule.pictureInPictureEnded("tab", at: 10) == nil)
    #expect(rule.becameActive(at: 40) == nil)
  }

  @Test func inTheAppOnlyAPlayOnReturns() {
    var rule = PictureInPictureReturn()
    #expect(rule.becameActive(at: 0) == nil)
    #expect(rule.pictureInPictureEnded("tab", at: 20) == nil)
    #expect(rule.playedOnAfterEnding("other", at: 20.2) == nil)
    #expect(rule.playedOnAfterEnding("tab", at: 20.3) == "tab")
    #expect(rule.playedOnAfterEnding("tab", at: 20.4) == nil)
  }

  @Test func aClosedTabIsForgotten() {
    var rule = PictureInPictureReturn()
    rule.resignedActive()
    _ = rule.pictureInPictureEnded("tab", at: 5)
    rule.forget("tab")
    #expect(rule.becameActive(at: 5.5) == nil)
  }
}

@MainActor
final class MediaMessages: NSObject, WKScriptMessageHandler {
  var bodies: [[String: Any]] = []

  func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
    if let body = message.body as? [String: Any] { bodies.append(body) }
  }

  func reports() -> [PageMediaReport] { bodies.compactMap(PageMediaReport.parse) }
}

@MainActor
struct PageMediaScriptTests {
  static let page = """
  <!doctype html><html><body><audio id="a" src="https://media.example.com/quiet.wav"></audio><audio id="b" src="https://media.example.com/other.wav" data-duration="9"></audio><audio id="beep" src="https://media.example.com/beep.wav" data-duration="1"></audio><script>
  window.seen = [];
  document.addEventListener("visibilitychange", () => window.seen.push(document.visibilityState));
  </script></body></html>
  """

  static let playableMedia = """
  (() => {
    const proto = HTMLMediaElement.prototype;
    const states = new WeakMap();
    const state = (element) => { if (!states.has(element)) states.set(element, { paused: true, time: 0 }); return states.get(element); };
    Object.defineProperty(proto, "paused", { configurable: true, get() { return state(this).paused; } });
    Object.defineProperty(proto, "duration", { configurable: true, get() { return Number(this.dataset.duration || 8); } });
    Object.defineProperty(proto, "currentTime", { configurable: true, get() { return state(this).time; }, set(value) { state(this).time = Math.min(Math.max(0, Number(value) || 0), 8); } });
    proto.play = function () { if (this.dataset.refuse) return Promise.reject(new Error("refused")); state(this).paused = false; this.dispatchEvent(new Event("play")); this.dispatchEvent(new Event("playing")); return Promise.resolve(); };
    proto.pause = function () { if (state(this).paused) return; state(this).paused = true; this.dispatchEvent(new Event("pause")); };
  })();
  """

  func load(keepsPlaying: Bool, pausedHold: TimeInterval = PageMediaScript.pausedHold) async throws -> (WKWebView, MediaMessages) {
    let configuration = WKWebViewConfiguration()
    configuration.mediaTypesRequiringUserActionForPlayback = []
    let messages = MediaMessages()
    configuration.userContentController.add(messages, contentWorld: .page, name: PageMediaScript.handlerName)
    configuration.userContentController.addUserScript(WKUserScript(source: Self.playableMedia, injectionTime: .atDocumentStart, forMainFrameOnly: false, in: .page))
    configuration.userContentController.addUserScript(WKUserScript(source: PageMediaScript.source(keepsPlaying: keepsPlaying, pausedHold: pausedHold), injectionTime: .atDocumentStart, forMainFrameOnly: false, in: .page))
    let webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 400, height: 800), configuration: configuration)
    try await PageLoader().load(into: webView, Self.page, base: "https://media.example.com/")
    return (webView, messages)
  }

  func run(_ webView: WKWebView, _ script: String) async throws -> Any? {
    try await webView.callAsyncJavaScript(script, contentWorld: .page)
  }

  @discardableResult
  func command(_ webView: WKWebView, _ command: PageMediaCommand, token: String, seconds: Int? = nil) async throws -> Bool {
    try await webView.evaluateJavaScript(try #require(command.script(token: token, seconds: seconds)), in: nil, contentWorld: .page) as? Bool == true
  }

  func hide(_ webView: WKWebView) async throws {
    _ = try await run(webView, "document.dispatchEvent(new Event('visibilitychange', { bubbles: true })); return true;")
  }

  func seen(_ webView: WKWebView) async throws -> [String]? {
    try await run(webView, "return [document.visibilityState, String(window.seen.length)]") as? [String]
  }

  func until(_ seconds: Double = 4, _ check: () async -> Bool) async throws {
    let end = Date().addingTimeInterval(seconds)
    while await !check(), Date() < end { try await Task.sleep(for: .milliseconds(50)) }
  }

  func startPlaying(_ webView: WKWebView, _ messages: MediaMessages) async throws -> PageMediaReport {
    _ = try await run(webView, "await document.getElementById('a').play(); return true;")
    try await until { messages.reports().last?.state == .playing }
    return try #require(messages.reports().last)
  }

  @Test func reportsAPlayingElementAndItsMediaSession() async throws {
    let (webView, messages) = try await load(keepsPlaying: true)
    _ = try await run(webView, """
      navigator.mediaSession.metadata = new MediaMetadata({ title: "Quiet\\nsong", artist: "Nobody", artwork: [{ src: "/art.png", sizes: "192x192" }, { src: "http://plain.example.com/a.png", sizes: "96x96" }] });
      navigator.mediaSession.setActionHandler("nexttrack", () => { window.nextPressed = true; });
      return true;
      """)
    let report = try await startPlaying(webView, messages)
    #expect(report.title == "Quiet song")
    #expect(report.artist == "Nobody")
    #expect(report.artworkURL == "https://media.example.com/art.png")
    #expect(report.canNext && !report.canPrevious)
    #expect(report.duration.map { abs($0 - 8) < 0.1 } == true)
    #expect(!report.hasVideo)
  }

  @Test func commandsNeedTheFramesOwnToken() async throws {
    let (webView, messages) = try await load(keepsPlaying: true)
    _ = try await run(webView, "navigator.mediaSession.setActionHandler('nexttrack', () => { window.nextPressed = true; }); return true;")
    let report = try await startPlaying(webView, messages)
    try await command(webView, .next, token: "zzzzzzzzzz")
    #expect(try await run(webView, "return window.nextPressed === true") as? Bool == false)
    try await command(webView, .next, token: report.token)
    #expect(try await run(webView, "return window.nextPressed === true") as? Bool == true)
    try await command(webView, .pause, token: report.token)
    try await until { messages.reports().last?.state == .paused }
    #expect(messages.reports().last?.state == .paused)
  }

  @Test func skipMovesByTheAskedSeconds() async throws {
    let (webView, messages) = try await load(keepsPlaying: true)
    let report = try await startPlaying(webView, messages)
    try await command(webView, .pause, token: report.token)
    _ = try await run(webView, "document.getElementById('a').currentTime = 1; return true;")
    try await command(webView, .skip, token: report.token, seconds: 15)
    let end = try await run(webView, "return document.getElementById('a').currentTime") as? Double ?? 0
    #expect(end > 7.5 && end <= 8)
    try await command(webView, .skip, token: report.token, seconds: -30)
    #expect(try await run(webView, "return document.getElementById('a').currentTime") as? Double == 0)
  }

  @Test func aPlayingPageKeepsBelievingItIsShown() async throws {
    let (webView, messages) = try await load(keepsPlaying: true)
    #expect(try await run(webView, "return document.hidden") as? Bool == true)
    _ = try await startPlaying(webView, messages)
    _ = try await run(webView, "document.dispatchEvent(new Event('visibilitychange', { bubbles: true })); return true;")
    #expect(try await run(webView, "return [document.visibilityState, String(document.hidden), String(window.seen.length)]") as? [String] == ["visible", "false", "0"])
    #expect(messages.bodies.contains { $0["type"] as? String == "left" && $0["outcome"] as? String == "held" })
    _ = try await run(webView, "document.getElementById('a').pause(); return true;")
    try await Task.sleep(for: .milliseconds(1500))
    #expect(try await run(webView, "return [document.visibilityState, String(window.seen.length)]") as? [String] == ["visible", "0"])
  }

  @Test func withTheSettingOffThePageSeesItIsHidden() async throws {
    let (webView, messages) = try await load(keepsPlaying: false)
    _ = try await startPlaying(webView, messages)
    _ = try await run(webView, "document.dispatchEvent(new Event('visibilitychange', { bubbles: true })); return true;")
    #expect(try await run(webView, "return [document.visibilityState, String(window.seen.length)]") as? [String] == ["hidden", "1"])
  }

  @Test func turningTheSettingOffReleasesAHeldPage() async throws {
    let (webView, messages) = try await load(keepsPlaying: true)
    let report = try await startPlaying(webView, messages)
    _ = try await run(webView, "document.dispatchEvent(new Event('visibilitychange', { bubbles: true })); return true;")
    try await command(webView, .keepPlaying, token: report.token, seconds: 0)
    #expect(try await run(webView, "return [document.visibilityState, String(window.seen.length)]") as? [String] == ["hidden", "1"])
  }

  func helloToken(_ messages: MediaMessages) async throws -> String {
    try await until { messages.bodies.contains { $0["type"] as? String == "hello" } }
    return try #require(messages.bodies.first { $0["type"] as? String == "hello" }?["token"] as? String)
  }

  @Test func aLoadedPageTakesTheSettingBeforeItEverPlays() async throws {
    let (offPage, offMessages) = try await load(keepsPlaying: true)
    try await command(offPage, .keepPlaying, token: try await helloToken(offMessages), seconds: 0)
    _ = try await startPlaying(offPage, offMessages)
    _ = try await run(offPage, "document.dispatchEvent(new Event('visibilitychange', { bubbles: true })); return true;")
    #expect(try await run(offPage, "return [document.visibilityState, String(window.seen.length)]") as? [String] == ["hidden", "1"])

    let (onPage, onMessages) = try await load(keepsPlaying: false)
    try await command(onPage, .keepPlaying, token: try await helloToken(onMessages), seconds: 1)
    _ = try await startPlaying(onPage, onMessages)
    _ = try await run(onPage, "document.dispatchEvent(new Event('visibilitychange', { bubbles: true })); return true;")
    #expect(try await run(onPage, "return [document.visibilityState, String(window.seen.length)]") as? [String] == ["visible", "0"])
  }

  @Test func aRefusedPlayReportsThePausedStateAgain() async throws {
    let (webView, messages) = try await load(keepsPlaying: true)
    let report = try await startPlaying(webView, messages)
    try await command(webView, .pause, token: report.token)
    try await until { messages.reports().last?.state == .paused }
    let before = messages.reports().count
    _ = try await run(webView, "document.getElementById('a').dataset.refuse = '1'; return true;")
    try await command(webView, .play, token: report.token)
    try await until { messages.reports().count > before }
    #expect(messages.reports().count > before)
    #expect(messages.reports().last?.state == .paused)
  }

  @Test func aMutedSoundIsNotOffered() async throws {
    let (webView, messages) = try await load(keepsPlaying: true)
    _ = try await run(webView, "const a = document.getElementById('a'); a.muted = true; await a.play(); return true;")
    try await Task.sleep(for: .milliseconds(700))
    #expect(!messages.reports().contains { $0.state == .playing })
  }

  @Test func aCommandWithNothingToControlAnswersNoAndReportsAgain() async throws {
    let (webView, messages) = try await load(keepsPlaying: true)
    let token = try await helloToken(messages)
    let before = messages.reports().count
    #expect(try await command(webView, .play, token: token) == false)
    try await until { messages.reports().count > before }
    #expect(messages.reports().last?.state == PageMediaReport.State.none)
    #expect(try await command(webView, .play, token: "zzzzzzzzzz") == false)
    #expect(try await command(webView, .keepPlaying, token: token, seconds: 1) == true)
  }

  @Test func aShortSoundDoesNotTakeOverFromTheLongOne() async throws {
    let (webView, messages) = try await load(keepsPlaying: true)
    _ = try await startPlaying(webView, messages)
    _ = try await run(webView, "await document.getElementById('beep').play(); return true;")
    try await Task.sleep(for: .milliseconds(300))
    let last = try #require(messages.reports().last)
    #expect(last.state == .playing)
    #expect(last.duration.map { abs($0 - 8) < 0.1 } == true)
  }

  @Test func whenTheNewerSoundPausesTheOneStillPlayingIsReportedAndHeld() async throws {
    let (webView, messages) = try await load(keepsPlaying: true)
    let first = try await startPlaying(webView, messages)
    _ = try await run(webView, "await document.getElementById('b').play(); return true;")
    try await until { messages.reports().last?.duration.map { abs($0 - 9) < 0.1 } == true }
    let second = try #require(messages.reports().last)
    #expect(second.plays == first.plays + 1)
    _ = try await run(webView, "document.getElementById('b').pause(); return true;")
    try await until { messages.reports().last?.duration.map { abs($0 - 8) < 0.1 } == true }
    let back = try #require(messages.reports().last)
    #expect(back.state == .playing)
    #expect(back.plays == second.plays)
    try await hide(webView)
    #expect(try await seen(webView) == ["visible", "0"])
  }

  func leaveAndLetWebKitPause(_ webView: WKWebView, _ messages: MediaMessages, token: String) async throws {
    #expect(try await command(webView, .leave, token: token))
    try await hide(webView)
    _ = try await run(webView, "document.getElementById('a').pause(); return true;")
    try await until { messages.bodies.contains { $0["type"] as? String == "left" && $0["outcome"] as? String == "resumed" } }
    try await until { messages.reports().last?.state == .playing }
  }

  @Test func undoingWebKitsPauseIsNotANewStartButARestartIs() async throws {
    let (webView, messages) = try await load(keepsPlaying: true)
    let first = try await startPlaying(webView, messages)
    try await leaveAndLetWebKitPause(webView, messages, token: first.token)
    #expect(messages.reports().last?.plays == first.plays)
    try await command(webView, .returned, token: first.token)
    _ = try await run(webView, "document.getElementById('a').pause(); return true;")
    try await until { messages.reports().last?.state == .paused }
    _ = try await run(webView, "await document.getElementById('a').play(); return true;")
    try await until { messages.reports().last?.state == .playing }
    #expect(messages.reports().last?.plays == first.plays + 1)
  }

  @Test func aPauseAfterTheRecoveryStillLetsThePageHideAfterTheHold() async throws {
    let (webView, messages) = try await load(keepsPlaying: true, pausedHold: 0.4)
    let first = try await startPlaying(webView, messages)
    try await leaveAndLetWebKitPause(webView, messages, token: first.token)
    _ = try await run(webView, "document.getElementById('a').pause(); return true;")
    try await Task.sleep(for: .milliseconds(150))
    #expect(try await run(webView, "return document.getElementById('a').paused") as? Bool == true)
    #expect(try await seen(webView) == ["visible", "0"])
    try await until(2) { (try? await seen(webView)) == ["hidden", "1"] }
    #expect(try await seen(webView) == ["hidden", "1"])
  }

  @Test func aPlayAgainKeepsTheHoldPastItsPause() async throws {
    let (webView, messages) = try await load(keepsPlaying: true, pausedHold: 0.4)
    _ = try await startPlaying(webView, messages)
    try await hide(webView)
    _ = try await run(webView, "document.getElementById('a').pause(); return true;")
    try await Task.sleep(for: .milliseconds(200))
    _ = try await run(webView, "await document.getElementById('a').play(); return true;")
    try await Task.sleep(for: .milliseconds(600))
    #expect(try await seen(webView) == ["visible", "0"])
  }

  @Test func aRestoredPageSaysWhichSettingItHas() async throws {
    let (webView, messages) = try await load(keepsPlaying: true)
    let token = try await helloToken(messages)
    #expect(messages.bodies.first { $0["type"] as? String == "hello" }?["keepsPlaying"] as? Bool == true)
    try await command(webView, .keepPlaying, token: token, seconds: 0)
    _ = try await run(webView, "window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); return true;")
    try await until { messages.bodies.filter { $0["type"] as? String == "hello" }.count == 2 }
    #expect(messages.bodies.last { $0["type"] as? String == "hello" }?["keepsPlaying"] as? Bool == false)
    try await until { messages.reports().last?.keepsPlaying == false }
    #expect(messages.reports().last?.keepsPlaying == false)
  }

  @Test func thePageCannotTakeTheCommandEntry() async throws {
    let (webView, _) = try await load(keepsPlaying: true)
    let kept = try await run(webView, "try { window.__ardiaMediaCommand = () => 'mine'; } catch (_) {} return window.__ardiaMediaCommand('zzzzzzzzzz', 'play', 0) === false;") as? Bool
    #expect(kept == true)
  }
}

struct PageMediaRetentionTests {
  typealias Candidate = PageMediaRetention.Candidate

  @Test func playingPagesComeBeforeNewerPausedOnes() {
    let kept = PageMediaRetention.kept([
      Candidate(id: "a", audible: true, startedAt: 10, pausedAt: nil),
      Candidate(id: "b", audible: false, startedAt: 20, pausedAt: 25),
      Candidate(id: "c", audible: false, startedAt: 30, pausedAt: 35),
    ], now: 40)
    #expect(kept.audible == ["a"])
    #expect(kept.paused == ["c", "b"])
    #expect(kept.nextExpiry == 25 + PageMediaRetention.pausedFor)
  }

  @Test func pausedPagesExpire() {
    let kept = PageMediaRetention.kept([Candidate(id: "b", audible: false, startedAt: 0, pausedAt: 0)], now: PageMediaRetention.pausedFor + 1)
    #expect(kept.audible.isEmpty && kept.paused.isEmpty && kept.nextExpiry == nil)
  }

  @Test func everyAudiblePageIsKeptAndOnlyPausedOnesAreBounded() {
    let kept = PageMediaRetention.kept([
      Candidate(id: "a", audible: true, startedAt: 1, pausedAt: nil),
      Candidate(id: "b", audible: true, startedAt: 2, pausedAt: nil),
      Candidate(id: "c", audible: true, startedAt: 3, pausedAt: nil),
      Candidate(id: "d", audible: false, startedAt: 4, pausedAt: 5),
      Candidate(id: "e", audible: false, startedAt: 5, pausedAt: 6),
      Candidate(id: "f", audible: false, startedAt: 6, pausedAt: 7),
    ], now: 8)
    #expect(kept.audible == ["c", "b", "a"])
    #expect(kept.paused == ["f", "e"])
  }
}

@MainActor
struct MediaRosterTests {
  @Test func anAudiblePageOutlivesTheLimitAndMemoryPressureWhileAPausedOneOnlyOutlivesTheLimit() {
    let roster = LivePageRoster<FakePage>(limit: 6)
    let ids = (0..<8).map { _ in UUID() }
    let pages = ids.map { _ in FakePage() }
    for (id, page) in zip(ids, pages) { roster.register(page, for: id) }
    roster.kept = [ids[0]]
    roster.keptWhileMemoryAllows = [ids[1]]
    for id in ids { roster.activate(id) }
    #expect(pages[0].isLive)
    #expect(pages[1].isLive)
    #expect(roster.liveIDs.count == 6)
    roster.discardAll(keeping: [ids[7]])
    #expect(pages[0].isLive)
    #expect(!pages[1].isLive)
    #expect(pages[7].isLive)
  }

  @Test func threePlayingPagesAllOutliveATightLimitAndMemoryPressure() {
    let roster = LivePageRoster<FakePage>(limit: 2)
    let ids = (0..<6).map { _ in UUID() }
    let pages = ids.map { _ in FakePage() }
    for (id, page) in zip(ids, pages) { roster.register(page, for: id) }
    let kept = PageMediaRetention.kept((0..<3).map { PageMediaRetention.Candidate(id: String($0), audible: true, startedAt: Double($0), pausedAt: nil) } + [PageMediaRetention.Candidate(id: "3", audible: false, startedAt: 3, pausedAt: 3)], now: 4)
    roster.kept = Set(kept.audible.compactMap { Int($0) }.map { ids[$0] })
    roster.keptWhileMemoryAllows = Set(kept.paused.compactMap { Int($0) }.map { ids[$0] })
    for id in ids { roster.activate(id) }
    #expect(pages[0].isLive && pages[1].isLive && pages[2].isLive && pages[3].isLive)
    roster.discardAll(keeping: [ids[5]])
    #expect(pages[0].isLive && pages[1].isLive && pages[2].isLive)
    #expect(!pages[3].isLive && !pages[4].isLive)
    #expect(pages[5].isLive)
  }
}
