import AVKit
import UIKit
import WebKit

@MainActor
final class WebVideoFloat {
  enum Outcome: String {
    case floated
    case keptPlaying
  }

  static let keptPlayingCheck: TimeInterval = 5
  static let playbackAnswerLimit: TimeInterval = 1

  private var observer: NSObjectProtocol?
  private var departure = 0

  init(liveWebViews: @escaping @MainActor () -> [WKWebView], report: @escaping @MainActor (Outcome) -> Void) {
    observer = NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.leftForeground(liveWebViews, report) }
    }
  }

  private func leftForeground(_ liveWebViews: @escaping @MainActor () -> [WKWebView], _ report: @escaping @MainActor (Outcome) -> Void) {
    departure += 1
    guard Self.isPresentingWebVideo else { return }
    report(.floated)
    let departed = departure
    Task { @MainActor [weak self] in
      try? await Task.sleep(for: .seconds(Self.keptPlayingCheck))
      guard let self, self.departure == departed, UIApplication.shared.applicationState == .background, Self.isPresentingWebVideo,
            await Self.anyPlaying(liveWebViews()),
            self.departure == departed, UIApplication.shared.applicationState == .background else { return }
      report(.keptPlaying)
    }
  }

  static var isPresentingWebVideo: Bool {
    UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap(\.windows)
      .contains { window in
        !window.isHidden && window.rootViewController?.children.contains { $0 is AVPlayerViewController } == true
      }
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

  func webVideoLeftForeground(_ outcome: WebVideoFloat.Outcome) {
    pageSink?(["name": "pages.webVideo", "outcome": outcome.rawValue, "isPrivate": !engine.tabs.privateTabs.isEmpty])
  }
}
