import ArdiaBrowser
import QuartzCore
import UIKit
import WebKit

@MainActor
final class FindPresentation {
  static var current: FindPresentation?
  private static let uncoverFrames = 90

  let pageID: String
  private weak var webView: WKWebView?
  private weak var interaction: UIFindInteraction?
  private let document: URL?
  private let generation: Int
  private let started = CACurrentMediaTime()
  private var task: Task<Void, Never>?

  init(pageID: String, webView: WKWebView, interaction: UIFindInteraction, generation: Int) {
    self.pageID = pageID
    self.webView = webView
    self.interaction = interaction
    self.generation = generation
    document = webView.url
  }

  static func cancel(for pageID: String) {
    guard let current, current.pageID == pageID else { return }
    current.cancel()
  }

  func watch() {
    FindPresentation.current = self
    task = Task { @MainActor [weak self] in
      for _ in 0..<FindPresentation.uncoverFrames {
        try? await Task.sleep(for: .milliseconds(16))
        guard let self, !Task.isCancelled, FindPresentation.current === self else { return }
        guard let page = PhonePages.shared.page(self.pageID), let webView = self.webView, page.webView === webView, page.navigationGeneration == self.generation, webView.window != nil, webView.url == self.document, let interaction = self.interaction, webView.findInteraction === interaction else {
          self.finish("dropped")
          return
        }
        if interaction.isFindNavigatorVisible {
          self.finish("visible")
          return
        }
        if webView.window?.rootViewController?.presentedViewController == nil {
          page.presentFindInPage()
          self.finish("presented again once uncovered")
          return
        }
      }
      self?.finish("gave up")
    }
  }

  func cancel() {
    task?.cancel()
    task = nil
    if FindPresentation.current === self { FindPresentation.current = nil }
  }

  private func finish(_ outcome: String) {
    NSLog("PAGELAB find navigator %@ %ld ms after present", outcome, Int((CACurrentMediaTime() - started) * 1000))
    task = nil
    if FindPresentation.current === self { FindPresentation.current = nil }
  }
}
