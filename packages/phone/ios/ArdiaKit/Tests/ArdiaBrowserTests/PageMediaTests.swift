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
  }

  @Test func commandScriptsCarryOnlyACheckedTokenAndANumber() throws {
    let script = try #require(PageMediaCommand.skip.script(token: "abc123def0", seconds: -10))
    #expect(script.contains("(\"abc123def0\", \"skip\", -10)"))
    #expect(PageMediaCommand.skip.script(token: "abc123def0", seconds: nil) == nil)
    #expect(PageMediaCommand.play.script(token: "abc\"); alert(1); (\"", seconds: nil) == nil)
    #expect(try #require(PageMediaCommand.keepPlaying.script(token: "abc123def0", seconds: 1)).contains("\"keepPlaying\", 1)"))
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
  <!doctype html><html><body><audio id="a" src="https://media.example.com/quiet.wav"></audio><script>
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
    Object.defineProperty(proto, "duration", { configurable: true, get() { return 8; } });
    Object.defineProperty(proto, "currentTime", { configurable: true, get() { return state(this).time; }, set(value) { state(this).time = Math.min(Math.max(0, Number(value) || 0), 8); } });
    proto.play = function () { state(this).paused = false; this.dispatchEvent(new Event("play")); this.dispatchEvent(new Event("playing")); return Promise.resolve(); };
    proto.pause = function () { if (state(this).paused) return; state(this).paused = true; this.dispatchEvent(new Event("pause")); };
  })();
  """

  func load(keepsPlaying: Bool) async throws -> (WKWebView, MediaMessages) {
    let configuration = WKWebViewConfiguration()
    configuration.mediaTypesRequiringUserActionForPlayback = []
    let messages = MediaMessages()
    configuration.userContentController.add(messages, contentWorld: .page, name: PageMediaScript.handlerName)
    configuration.userContentController.addUserScript(WKUserScript(source: Self.playableMedia, injectionTime: .atDocumentStart, forMainFrameOnly: false, in: .page))
    configuration.userContentController.addUserScript(WKUserScript(source: PageMediaScript.source(keepsPlaying: keepsPlaying), injectionTime: .atDocumentStart, forMainFrameOnly: false, in: .page))
    let webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 400, height: 800), configuration: configuration)
    try await PageLoader().load(into: webView, Self.page, base: "https://media.example.com/")
    return (webView, messages)
  }

  func run(_ webView: WKWebView, _ script: String) async throws -> Any? {
    try await webView.callAsyncJavaScript(script, contentWorld: .page)
  }

  func command(_ webView: WKWebView, _ command: PageMediaCommand, token: String, seconds: Int? = nil) async throws {
    _ = try await webView.evaluateJavaScript(try #require(command.script(token: token, seconds: seconds)), in: nil, contentWorld: .page)
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
    #expect(try await run(webView, "return [document.visibilityState, String(window.seen.length)]") as? [String] == ["visible", "0"])
    try await until { (try? await run(webView, "return window.seen.length")) as? Int == 1 }
    #expect(try await run(webView, "return [document.visibilityState, window.seen[0]]") as? [String] == ["hidden", "hidden"])
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

  @Test func aMutedSoundIsNotOffered() async throws {
    let (webView, messages) = try await load(keepsPlaying: true)
    _ = try await run(webView, "const a = document.getElementById('a'); a.muted = true; await a.play(); return true;")
    try await Task.sleep(for: .milliseconds(700))
    #expect(!messages.reports().contains { $0.state == .playing })
  }

  @Test func thePageCannotTakeTheCommandEntry() async throws {
    let (webView, _) = try await load(keepsPlaying: true)
    let kept = try await run(webView, "try { window.__ardiaMediaCommand = () => 'mine'; } catch (_) {} return window.__ardiaMediaCommand('zzzzzzzzzz', 'play', 0) === false;") as? Bool
    #expect(kept == true)
  }
}
