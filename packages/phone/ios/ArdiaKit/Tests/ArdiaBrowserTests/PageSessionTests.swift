import Foundation
import Testing
import WebKit
@testable import ArdiaBrowser

@MainActor
@Suite struct PageSessionTests {
  final class Finished: NSObject, WKNavigationDelegate {
    var waiting: CheckedContinuation<Void, Never>?
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
      waiting?.resume()
      waiting = nil
    }
  }

  let pages: URL = {
    let folder = FileManager.default.temporaryDirectory.appending(path: "page-session-\(UUID().uuidString)")
    try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    for name in ["a", "b"] {
      try? "<title>\(name)</title>\(name)".write(to: folder.appending(path: "\(name).html"), atomically: true, encoding: .utf8)
    }
    return folder
  }()

  func load(_ webView: WKWebView, _ name: String, delegate: Finished) async {
    await withCheckedContinuation { continuation in
      delegate.waiting = continuation
      webView.loadFileURL(pages.appending(path: "\(name).html"), allowingReadAccessTo: pages)
    }
  }

  @Test func aWebViewThatHasNotLoadedNeverReplacesTheSavedSession() async throws {
    let delegate = Finished()
    let loaded = WKWebView()
    loaded.navigationDelegate = delegate
    await load(loaded, "a", delegate: delegate)
    await load(loaded, "b", delegate: delegate)
    let saved = try #require(loaded.interactionState as? Data)
    #expect(loaded.backForwardList.backList.count == 1)

    let blank = WKWebView()
    let blankSession = try #require(blank.interactionState as? Data)
    #expect(blankSession != saved)
    #expect(PageSession.toSave(from: blank, stored: saved) == saved)
    #expect(PageSession.toSave(from: nil, stored: saved) == saved)

    let restored = WKWebView()
    restored.interactionState = PageSession.toSave(from: blank, stored: saved)
    #expect(restored.backForwardList.currentItem?.url.lastPathComponent == "b.html")
    #expect(restored.backForwardList.backList.map(\.url.lastPathComponent) == ["a.html"])
  }

  @Test func aLoadedWebViewSavesItsOwnSession() async throws {
    let delegate = Finished()
    let loaded = WKWebView()
    loaded.navigationDelegate = delegate
    await load(loaded, "a", delegate: delegate)
    let live = try #require(loaded.interactionState as? Data)
    #expect(PageSession.toSave(from: loaded, stored: Data([1, 2, 3])) == live)
  }

  final class Commits: NSObject, WKNavigationDelegate {
    var urls: [String] = []
    var waiting: CheckedContinuation<Void, Never>?
    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) { urls.append(webView.url?.lastPathComponent ?? "") }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
      waiting?.resume()
      waiting = nil
    }
  }

  @Test func backOnABlankWebViewRestoresTheSavedHistoryWithoutLoadingTheDeadPage() async throws {
    let delegate = Finished()
    let loaded = WKWebView()
    loaded.navigationDelegate = delegate
    await load(loaded, "a", delegate: delegate)
    await load(loaded, "b", delegate: delegate)
    let saved = try #require(loaded.interactionState as? Data)

    let commits = Commits()
    let remounted = WKWebView()
    remounted.navigationDelegate = commits
    #expect(!remounted.canGoBack)
    var went = false
    await withCheckedContinuation { continuation in
      commits.waiting = continuation
      went = PageSession.restore(saved, into: remounted, goingBy: -1)
    }
    #expect(went)
    #expect(remounted.url?.lastPathComponent == "a.html")
    #expect(commits.urls == ["a.html"])
    #expect(remounted.backForwardList.forwardList.map(\.url.lastPathComponent) == ["b.html"])
    #expect(remounted.canGoForward)
  }

  @Test func forwardWithNothingAheadSaysSo() async throws {
    let delegate = Finished()
    let loaded = WKWebView()
    loaded.navigationDelegate = delegate
    await load(loaded, "a", delegate: delegate)
    await load(loaded, "b", delegate: delegate)
    let saved = try #require(loaded.interactionState as? Data)
    #expect(!PageSession.restore(saved, into: WKWebView(), goingBy: 1))
  }
}
