import ArdiaBrowser
import UIKit
import WebKit

extension PageView {
  @MainActor
  func pinchMoment() -> PagePinch.Moment? {
    guard let page, let webView = hostedWebView, webView.superview === self, page.webView === webView, madeGestures?.isSwiping != true else { return nil }
    let visible = window != nil && webView.window != nil && !webView.isHidden && !isHidden && alpha > 0.01 && UIApplication.shared.applicationState == .active
    let scroller = webView.scrollView
    return PagePinch.Moment(
      page: page.id,
      navigation: page.navigationGeneration,
      zoomScale: Double(scroller.zoomScale),
      minimumZoomScale: Double(scroller.minimumZoomScale),
      isVisible: visible && Self.summarizes(page.url),
      isLoading: page.isLoading || webView.isLoading
    )
  }

  static func summarizes(_ url: URL?) -> Bool {
    guard let scheme = url?.scheme?.lowercased() else { return false }
    return scheme == "https" || scheme == "http"
  }

  func place(_ webView: WKWebView, in frame: CGRect) {
    if webView.transform.isIdentity {
      if webView.frame != frame { webView.frame = frame }
      return
    }
    let bounds = CGRect(origin: webView.bounds.origin, size: frame.size)
    if webView.bounds != bounds { webView.bounds = bounds }
    let center = CGPoint(x: frame.midX, y: frame.midY)
    if webView.center != center { webView.center = center }
  }

  @MainActor
  var pinchIsPending: Bool {
    guard let hostedWebView else { return summaryStage != nil }
    return summaryStage != nil || madePinchWatcher?.isHolding == true || hostedWebView.alpha < 1 || !hostedWebView.transform.isIdentity || hostedWebView.layer.masksToBounds
  }

  @MainActor
  func cancelPendingShot() {
    pageShotRequest += 1
    pageShot = nil
    deliveredShotSize = nil
    pageShotWaiters = []
  }

  @MainActor
  func shootPage() {
    cancelPendingShot()
    let size = webViewFrame.size
    guard let webView = hostedWebView, shotGeometryHolds(size) else { return deliverShot(nil, request: pageShotRequest, size: size) }
    let request = pageShotRequest
    if webView.transform.isIdentity, let copied = PageSnapshots.screenCopy(of: webView, width: webView.bounds.width), !PageSnapshots.isFlat(copied) {
      return deliverShot(copied, request: request, size: size)
    }
    webView.takeSnapshot(with: nil) { [weak self, weak webView] image, _ in
      MainActor.assumeIsolated {
        guard let self, self.pageShotRequest == request else { return }
        if let image { return self.deliverShot(image, request: request, size: size) }
        guard let webView, webView.bounds.width > 0, webView.bounds.height > 0 else { return self.deliverShot(nil, request: request, size: size) }
        let drawn = PageSnapshots.screenCopy(of: webView, width: webView.bounds.width)
        self.deliverShot(drawn, request: request, size: size)
      }
    }
  }

  @MainActor
  func withStatusStrip(_ image: UIImage) -> UIImage {
    let strip = safeAreaInsets.top
    guard strip > 0, image.size.height > strip, let tone = sentTone?.top else { return image }
    let format = UIGraphicsImageRendererFormat()
    format.scale = image.scale
    format.opaque = true
    return UIGraphicsImageRenderer(size: image.size, format: format).image { context in
      image.draw(at: .zero)
      UIColor(red: tone.red, green: tone.green, blue: tone.blue, alpha: 1).setFill()
      context.fill(CGRect(x: 0, y: 0, width: image.size.width, height: strip * image.size.width / max(bounds.width, 1)))
    }
  }

  @MainActor
  func deliverShot(_ image: UIImage?, request: Int, size: CGSize) {
    guard request == pageShotRequest else { return }
    let image = image.flatMap { shot -> UIImage? in
      let pixel = 1 / shot.scale
      guard shotGeometryHolds(size), abs(shot.size.width - size.width) < pixel,
            abs(shot.size.height - size.height) < pixel else { return nil }
      return withStatusStrip(shot)
    }
    pageShot = image
    deliveredShotSize = size
    let waiters = pageShotWaiters
    pageShotWaiters = []
    for waiter in waiters { waiter(image) }
    if image != nil, summaryStage == nil, madePinchWatcher?.isHolding == true, let lastHold { pinchHeld(lastHold) }
  }

  @MainActor
  func whenShot(_ done: @escaping (UIImage?) -> Void) {
    if deliveredShotSize != nil { return done(shotFitsPage ? pageShot : nil) }
    pageShotWaiters.append(done)
  }

  @MainActor
  var shotFitsPage: Bool { pageShot != nil && deliveredShotSize.map(shotGeometryHolds) == true }

  @MainActor
  func shotGeometryHolds(_ size: CGSize) -> Bool {
    size.width > 0 && size.height > 0 && webViewFrame.size == size && hostedWebView?.bounds.size == size
  }

  @MainActor
  func showsPageAtRest(_ webView: WKWebView) -> Bool {
    summaryStage == nil && leaving == nil && madePinchWatcher?.isHolding != true && webView.alpha > 0.99 && webView.transform.isIdentity
  }

  @MainActor
  static func unpinch(_ webView: WKWebView) {
    webView.layer.removeAllAnimations()
    webView.transform = .identity
    webView.alpha = 1
    webView.layer.cornerRadius = 0
    webView.layer.masksToBounds = false
  }

  @MainActor
  func restorePage(_ webView: WKWebView) {
    Self.unpinch(webView)
    pinchGround.isHidden = true
    lastHold = nil
    guard webView === hostedWebView, window != nil else { return }
    pinchNavigation = nil
    place(webView, in: webViewFrame)
    scheduleToneSample(after: .milliseconds(120))
  }

  @MainActor
  func finishLeaving() {
    guard let left = leaving else { return }
    leaving = nil
    left.stage.stop()
    left.stage.removeFromSuperview()
    guard summaryStage == nil, madePinchWatcher?.isHolding != true, let webView = left.webView else { return }
    restorePage(webView)
    if left.wasCommitted, webView === hostedWebView, window != nil { UIAccessibility.post(notification: .screenChanged, argument: webView) }
  }

  @MainActor
  func endPinchNow() {
    madePinchWatcher?.reset(notifying: false)
    dismissSummary(animated: false)
    guard let hostedWebView, hostedWebView.alpha < 1 || !hostedWebView.transform.isIdentity || hostedWebView.layer.masksToBounds || !pinchGround.isHidden else { return }
    restorePage(hostedWebView)
  }

  static func pinchTransform(_ hold: PagePinchWatcher.Hold) -> CGAffineTransform {
    CGAffineTransform(scaleX: PagePinch.shownWidthScale(for: hold.scale), y: PagePinch.shownScale(for: hold.scale)).translatedBy(x: hold.shift.x, y: hold.shift.y)
  }

  static func pinchCorner(_ hold: PagePinchWatcher.Hold) -> CGFloat {
    min(max((1 - PagePinch.shownScale(for: hold.scale)) * 10, 0), 1) * PageSummaryMotion.restingCorner
  }

  @MainActor
  var summaryLook: PageSummaryLook {
    PageSummaryLook(isPrivate: page?.isPrivate ?? isPrivate, appDark: traitCollection.userInterfaceStyle == .dark)
  }

  @MainActor
  func showPinchGround(under webView: WKWebView, look: PageSummaryLook) {
    pinchGround.backgroundColor = look.ground
    pinchGround.frame = bounds
    pinchGround.isHidden = false
    insertSubview(pinchGround, belowSubview: webView)
  }

  @MainActor
  func pinchTaken() {
    guard summaryStage == nil, let webView = hostedWebView else { return }
    lastHold = nil
    pinchNavigation = page?.navigationGeneration
    shootPage()
    showPinchGround(under: webView, look: summaryLook)
    webView.layer.cornerCurve = .continuous
    webView.layer.masksToBounds = true
  }

  @MainActor
  func raiseStage(_ image: UIImage) -> PageSummaryStage? {
    guard let window, let page, let webView = hostedWebView, webViewFrame.width > 0, webViewFrame.height > 0, image === pageShot, shotFitsPage else { return nil }
    finishLeaving()
    let look = summaryLook
    pinchGround.backgroundColor = look.ground
    let stage = PageSummaryStage(image: image, pageSize: webViewFrame.size, look: look)
    stage.frame = window.bounds
    stage.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    stage.onClose = { [weak self] in self?.dismissSummary(animated: true) }
    window.addSubview(stage)
    stage.layoutIfNeeded()
    summaryStage = stage
    stageWebView = webView
    stageNavigation = pinchNavigation ?? page.navigationGeneration
    return stage
  }

  @MainActor
  func pinchHeld(_ hold: PagePinchWatcher.Hold) {
    guard let webView = hostedWebView, summarySession == nil else { return }
    lastHold = hold
    let transform = UIAccessibility.isReduceMotionEnabled ? .identity : Self.pinchTransform(hold)
    let corner = Self.pinchCorner(hold)
    if summaryStage == nil, PagePinch.isEngaged(at: hold.scale), let pageShot { _ = raiseStage(pageShot) }
    if let stage = summaryStage {
      stage.hold(over: convert(webViewFrame, to: stage), transform: transform, fold: PagePinch.foldProgress(for: hold.scale), glow: PagePinch.glow(for: hold.scale), corner: corner)
      webView.alpha = 0
      webView.transform = .identity
    } else {
      webView.transform = transform
      webView.layer.cornerRadius = corner
    }
  }

  @MainActor
  func pinchLetGo(fired: Bool) {
    lastHold = nil
    guard let webView = hostedWebView, summarySession == nil else { return }
    if fired {
      if let stage = summaryStage {
        webView.alpha = 0
        webView.transform = .identity
        if !begin(.pinch, on: stage) { dismissSummary(animated: true) }
        return
      }
      let from = webView.transform
      let corner = webView.layer.cornerRadius
      let page = page
      let navigation = page?.navigationGeneration
      whenShot { [weak self] image in
        guard let self, self.summaryStage == nil, self.hostedWebView === webView, self.page === page, page?.navigationGeneration == navigation,
              let image, let stage = self.raiseStage(image) else {
          self?.settlePinch(webView)
          return
        }
        stage.hold(over: self.convert(self.webViewFrame, to: stage), transform: from, fold: 0, glow: 0, corner: corner)
        webView.alpha = 0
        webView.transform = .identity
        if !self.begin(.pinch, on: stage) { self.dismissSummary(animated: true) }
      }
      return
    }
    if summaryStage != nil { return dismissSummary(animated: true) }
    cancelPendingShot()
    settlePinch(webView)
  }

  @MainActor
  func settlePinch(_ webView: WKWebView) {
    guard webView === hostedWebView, window != nil, !UIAccessibility.isReduceMotionEnabled else { return restorePage(webView) }
    lastHold = nil
    let request = pageShotRequest
    UIView.animate(springDuration: 0.6, bounce: 0, options: [.beginFromCurrentState, .allowUserInteraction]) {
      webView.transform = .identity
      webView.layer.cornerRadius = 0
    } completion: { [weak self, weak webView] _ in
      guard let webView else { return }
      guard let self else { return Self.unpinch(webView) }
      guard self.pageShotRequest == request, self.summaryStage == nil, self.leaving == nil, self.madePinchWatcher?.isHolding != true else { return }
      self.restorePage(webView)
    }
  }

  @MainActor
  func summarize(_ trigger: PageSummarySession.Trigger) -> Bool {
    guard PageSummarySwitch.shared.isOn, registeredPageID != nil, let page, let moment = pinchMoment(), moment.isVisible, !moment.isLoading, window != nil else { return false }
    if let current = summarySession, current.isCurrent(for: page) {
      if case .failed = current.phase {} else { return true }
    }
    endPinchNow()
    guard let webView = hostedWebView else { return false }
    let navigation = page.navigationGeneration
    let revision = PageSummarySwitch.shared.revision
    pinchNavigation = navigation
    shootPage()
    whenShot { [weak self] image in
      guard let self, self.summaryStage == nil, self.hostedWebView === webView, self.page === page, page.navigationGeneration == navigation,
            PageSummarySwitch.shared.isCurrent(revision), let image, let stage = self.raiseStage(image) else { return }
      self.showPinchGround(under: webView, look: stage.model.look)
      stage.hold(over: self.convert(self.webViewFrame, to: stage), transform: .identity, fold: 0, glow: 0, corner: 0)
      webView.alpha = 0
      if !self.begin(trigger, on: stage) { self.dismissSummary(animated: false) }
    }
    return true
  }

  @MainActor
  func begin(_ trigger: PageSummarySession.Trigger, on stage: PageSummaryStage) -> Bool {
    guard PageSummarySwitch.shared.isOn, let pageID = registeredPageID, let page, let moment = pinchMoment(), moment.isVisible, !moment.isLoading,
          stageNavigation == page.navigationGeneration, shotGeometryHolds(stage.pageSize) else { return false }
    let session = PageSummarySession(trigger: trigger, tab: page)
    let isPrivate = page.isPrivate
    session.onSettled = { settled in
      PhonePages.shared.send(pageID, "page.summarySettled", ["trigger": settled.trigger.rawValue, "outcome": settled.outcome, "isPrivate": isPrivate])
    }
    summarySession = session
    stage.commit(session)
    session.start(page)
    PhonePages.shared.send(pageID, "page.summaryOpened", ["trigger": trigger.rawValue, "isPrivate": isPrivate])
    return true
  }

  @MainActor
  func dismissSummary(animated: Bool) {
    cancelPendingShot()
    if !animated { finishLeaving() }
    guard let stage = summaryStage else {
      guard leaving == nil, madePinchWatcher?.isHolding != true, let hostedWebView, pinchIsPending || !pinchGround.isHidden else { return }
      if animated { settlePinch(hostedWebView) } else { restorePage(hostedWebView) }
      return
    }
    let webView = stageWebView ?? hostedWebView
    summarySession?.cancel()
    summarySession = nil
    summaryStage = nil
    stageWebView = nil
    stageNavigation = nil
    finishLeaving()
    leaving = (stage, webView, stage.phase != .held)
    guard animated, stage.window != nil, window != nil else { return finishLeaving() }
    let fades = stage.reduced || stage.pageSize != webViewFrame.size
    if fades, let webView { restorePage(webView) }
    let done: () -> Void = { [weak self, weak stage, weak webView] in
      guard let self else {
        stage?.stop()
        stage?.removeFromSuperview()
        if let webView { Self.unpinch(webView) }
        return
      }
      if let stage, self.leaving?.stage === stage { self.finishLeaving() }
    }
    let pageFrame = convert(webViewFrame, to: stage)
    if fades { return stage.fadeOut(done) }
    if stage.phase == .held { stage.release(to: pageFrame, done: done) } else { stage.leave(to: pageFrame, done: done) }
  }
}
