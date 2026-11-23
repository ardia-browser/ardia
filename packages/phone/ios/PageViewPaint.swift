import ArdiaBrowser
import UIKit
import WebKit

extension PageView {
  @MainActor
  func shows(_ webView: WKWebView, since generation: Int) -> Bool {
    observing == generation && hostedWebView === webView && webView.superview === self && window != nil
  }

  @MainActor
  func probing(_ webView: WKWebView, of page: WebTab, navigation: Int, since generation: Int) -> Bool {
    shows(webView, since: generation) && self.page === page && page.webView === webView && page.navigationGeneration == navigation && (!page.isLoading || page.hasCommittedLoad) && PageSnapshots.isOnScreen(webView)
  }

  @MainActor
  func reportDrawnSoon() {
    guard !drawnSent, drawnTask == nil, window != nil, let page, let webView = hostedWebView, webView.superview === self, !webView.bounds.isEmpty else { return }
    startCoverCap()
    let generation = observing
    drawnTask = Task { @MainActor [weak self, weak webView, weak page] in
      var flatProbes = 0
      var navigation = page?.navigationGeneration ?? 0
      for attempt in 0..<PageView.drawnProbeTries {
        if attempt > 0 { try? await Task.sleep(for: PageView.drawnProbeGap) }
        guard !Task.isCancelled, let self, let probed = webView, let page else { return }
        if page.navigationGeneration != navigation {
          navigation = page.navigationGeneration
          flatProbes = 0
        }
        guard self.probing(probed, of: page, navigation: navigation, since: generation) else { continue }
        let probe = WKSnapshotConfiguration()
        probe.afterScreenUpdates = true
        probe.snapshotWidth = NSNumber(value: PageView.drawnProbeWidth)
        guard let image = try? await probed.takeSnapshot(configuration: probe) else { continue }
        guard !Task.isCancelled, self.probing(probed, of: page, navigation: navigation, since: generation) else { continue }
        let flat = await PageSnapshots.isFlatAwayFromMain(image)
        guard !Task.isCancelled, self.probing(probed, of: page, navigation: navigation, since: generation) else { continue }
        if flat {
          if page.isLoading { continue }
          flatProbes += 1
          if flatProbes < PageView.flatProbesAccepted { continue }
        }
        let presented = await NextFramePresented.wait()
        guard !Task.isCancelled else { return }
        guard presented, self.probing(probed, of: page, navigation: navigation, since: generation) else { continue }
        self.drawnTask = nil
        guard !self.drawnSent else { return }
        self.drawnSent = true
        self.drawnDelivered = true
        self.drawnDocument = navigation
        self.handOverCover(reason: "drawn")
        self.onPageEvent(["name": "drawn", "document": navigation])
        return
      }
      guard !Task.isCancelled, let self else { return }
      self.drawnTask = nil
    }
  }

  @MainActor
  var currentDocumentDrawn: Bool {
    guard drawnDelivered, let drawnDocument, let page else { return false }
    return drawnDocument == page.navigationGeneration
  }

  @MainActor
  func coverChanged() {
    coverCapTask?.cancel()
    coverCapTask = nil
    coverRetryTask?.cancel()
    coverRetryTask = nil
    restoreHiddenCover()
    coverHandedOver = false
    guard coverNativeID != nil else { return }
    if currentDocumentDrawn {
      handOverCover(reason: "drawn")
      return
    }
    if window != nil, hostedWebView?.superview === self { startCoverCap() }
  }

  @MainActor
  func startCoverCap() {
    guard coverNativeID != nil, !coverHandedOver, coverCapTask == nil else { return }
    coverCapTask = Task { @MainActor [weak self] in
      try? await Task.sleep(for: PageView.coverCap)
      guard !Task.isCancelled, let self else { return }
      self.coverCapTask = nil
      self.coverRetryTask?.cancel()
      self.coverRetryTask = nil
      if !self.hideCover(reason: "cap") { self.finishCover(reason: "cap", found: false) }
    }
  }

  @MainActor
  func handOverCover(reason: String) {
    guard coverNativeID != nil, !coverHandedOver, coverRetryTask == nil else { return }
    let forDraw = reason == "drawn"
    guard !forDraw || currentDocumentDrawn else { return }
    if hideCover(reason: reason) { return }
    let wanted = coverNativeID
    let document = drawnDocument
    coverRetryTask = Task { @MainActor [weak self] in
      for _ in 0..<PageView.coverRetries {
        try? await Task.sleep(for: PageView.coverRetryGap)
        guard !Task.isCancelled, let self, self.coverNativeID == wanted, !self.coverHandedOver else { return }
        guard !forDraw || (self.currentDocumentDrawn && self.drawnDocument == document) else {
          self.coverRetryTask = nil
          return
        }
        if self.hideCover(reason: reason) {
          self.coverRetryTask = nil
          return
        }
      }
      guard !Task.isCancelled, let self, self.coverNativeID == wanted else { return }
      self.coverRetryTask = nil
      self.finishCover(reason: "cap", found: false)
    }
  }

  @MainActor
  func hideCover(reason: String) -> Bool {
    guard let id = coverNativeID, !coverHandedOver, let window, let found = PageView.view(withNativeID: id, in: window) else { return false }
    hiddenCoverWasHidden = found.isHidden
    found.isHidden = true
    hiddenCover = found
    hiddenCoverID = id
    finishCover(reason: reason, found: true)
    return true
  }

  @MainActor
  func finishCover(reason: String, found: Bool) {
    guard let id = coverNativeID, !coverHandedOver else { return }
    coverHandedOver = true
    coverCapTask?.cancel()
    coverCapTask = nil
    coverRetryTask?.cancel()
    coverRetryTask = nil
    onPageEvent(["name": "coverHidden", "reason": reason, "found": found, "cover": id])
  }

  @MainActor
  func restoreHiddenCover() {
    defer {
      hiddenCover = nil
      hiddenCoverID = nil
    }
    guard let view = hiddenCover, let id = hiddenCoverID, view.isHidden else { return }
    let stillOurs = view.superview == nil || (view.responds(to: NSSelectorFromString(PageView.nativeIDKey)) && (view.value(forKey: PageView.nativeIDKey) as? String) == id)
    guard stillOurs else { return }
    view.isHidden = hiddenCoverWasHidden
  }

  static let nativeIDKey = "nativeId"

  static func view(withNativeID id: String, in root: UIView) -> UIView? {
    let selector = NSSelectorFromString(nativeIDKey)
    var queue: [UIView] = [root]
    var index = 0
    while index < queue.count {
      let view = queue[index]
      index += 1
      if view.responds(to: selector), (view.value(forKey: nativeIDKey) as? String) == id { return view }
      queue.append(contentsOf: view.subviews)
    }
    return nil
  }
}
