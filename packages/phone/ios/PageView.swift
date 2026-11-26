import ArdiaBrowser
import ArdiaDesign
import ExpoModulesCore
import Observation
import SwiftUI
import UIKit
import WebKit

final class PageView: ExpoView {
  let onPageEvent = EventDispatcher()

  var pageID: String?
  var initialURL: String?
  var title: String?
  var isPrivate = false
  var savedState: String?
  var toneInsets: (top: CGFloat, bottom: CGFloat) = (0, 0)
  var obscuredInsets: UIEdgeInsets = .zero {
    didSet { if obscuredInsets != oldValue { applyObscuredInsets() } }
  }
  var topClearance: CGFloat = 0 {
    didSet { if topClearance != oldValue { applyObscuredInsets() } }
  }
  var obscuresSafeTop = false {
    didSet { if obscuresSafeTop != oldValue { applyObscuredInsets() } }
  }
  var pinsSafeArea = false {
    didSet { if pinsSafeArea != oldValue { applyObscuredInsets() } }
  }
  var swipeNavigation: PageGestures.Swipe = .anywhere
  var closesOnSwipeBack = false
  var reopensOnSwipeForward = false
  var pullToRefresh = true
  private(set) var page: WebTab?

  weak var hostedWebView: WKWebView?
  private var failedID: String?
  private var sampled: PageTone?
  private var sentTone: PageTone?
  private var glassBarDark: Bool?
  private var sentBarDark: Bool?
  private var sentState: NSDictionary?
  private var wasLoading = false
  var observing = 0
  private var toneTask: Task<Void, Never>?
  private var scrollObservation: NSKeyValueObservation?
  private var contentSizeObservation: NSKeyValueObservation?
  private let sideMargins = UIView()
  private var lastScroll: TimeInterval = 0
  private var scrollRestTask: Task<Void, Never>?
  var drawnTask: Task<Void, Never>?
  var drawnSent = false
  var drawnDelivered = false
  var drawnDocument: Int?
  var coverHandedOver = false
  weak var hiddenCover: UIView?
  var hiddenCoverID: String?
  var hiddenCoverWasHidden = false
  var coverCapTask: Task<Void, Never>?
  var coverRetryTask: Task<Void, Never>?
  var lastFrameView: UIView?
  var hostedAt: CFTimeInterval = 0
  var coverNativeID: String? {
    didSet { if coverNativeID != oldValue { MainActor.assumeIsolated { coverChanged() } } }
  }
  static let coverCap: Duration = .milliseconds(200)
  static let coverRetryGap: Duration = .milliseconds(16)
  static let coverRetries = 12
  static let drawnProbeTries = 30
  static let flatProbesAccepted = 3
  static let scrollRest: TimeInterval = 0.5
  static let drawnProbeWidth: Double = 64
  private var madeGestures: PageGestures?
  private var madePinchWatcher: PagePinchWatcher?
  private var summaryStage: PageSummaryStage?
  private var summarySession: PageSummarySession?
  private weak var stageWebView: WKWebView?
  private var stageNavigation: Int?
  private var leaving: (stage: PageSummaryStage, webView: WKWebView?, wasCommitted: Bool)?
  private var pinchNavigation: Int?
  private var lastHold: PagePinchWatcher.Hold?
  private var pageShot: UIImage?
  private var pageShotRequest = 0
  private var pageShotWaiters: [(UIImage?) -> Void] = []
  private let pinchGround = UIView()
  private var registeredPageID: String?

  @MainActor private static let hosts = NSMapTable<NSString, PageView>.strongToWeakObjects()

  @MainActor
  static func host(of pageID: String) -> PageView? {
    guard let view = hosts.object(forKey: pageID as NSString), view.registeredPageID == pageID else { return nil }
    return view
  }

  @MainActor
  static func dismissAllSummaries() {
    for view in hosts.objectEnumerator()?.allObjects.compactMap({ $0 as? PageView }) ?? [] {
      view.madePinchWatcher?.reset()
      view.dismissSummary(animated: true)
    }
  }

  @MainActor
  static func stopAllSummaries() {
    for view in hosts.objectEnumerator()?.allObjects.compactMap({ $0 as? PageView }) ?? [] {
      view.madePinchWatcher?.reset()
      view.dismissSummary(animated: true)
    }
  }

  @MainActor
  private var gestures: PageGestures {
    if let madeGestures { return madeGestures }
    let made = PageGestures(container: self)
    made.onSwipedPastHistory = { [weak self] direction in
      self?.onPageEvent(["name": "swipedPastHistory", "direction": direction == .back ? "back" : "forward"])
    }
    madeGestures = made
    return made
  }

  @MainActor
  private var pinchWatcher: PagePinchWatcher {
    if let madePinchWatcher { return madePinchWatcher }
    let made = PagePinchWatcher(container: self)
    made.moment = { [weak self] in
      guard let self, PageSummarySwitch.shared.isOn, self.summarySession == nil else { return nil }
      return self.pinchMoment()
    }
    made.mayBegin = { [weak self] in
      guard let self, let webView = self.hostedWebView else { return false }
      return self.summaryStage == nil && self.leaving == nil && webView.alpha > 0.99 && webView.transform.isIdentity
    }
    made.onTaken = { [weak self] in self?.pinchTaken() }
    made.onHeld = { [weak self] in self?.pinchHeld($0) }
    made.onLetGo = { [weak self] in self?.pinchLetGo(fired: $0) }
    madePinchWatcher = made
    return made
  }

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    sideMargins.isUserInteractionEnabled = false
    sideMargins.isHidden = true
    addSubview(sideMargins)
    pinchGround.isUserInteractionEnabled = false
    pinchGround.isHidden = true
    pinchGround.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    addSubview(pinchGround)
    NotificationCenter.default.addObserver(self, selector: #selector(glassToneChanged(_:)), name: GlassTone.changed, object: nil)
  }

  @objc private func glassToneChanged(_ note: Notification) {
    guard let web = note.object as? WKWebView, web === hostedWebView, let page else { return }
    glassBarDark = note.userInfo?[GlassTone.darkKey] as? Bool
    sendTone(theme: page.themeColor, underPage: page.underPageBackgroundColor)
  }

  @MainActor
  func bind() {
    gestures.swipe = swipeNavigation
    gestures.closesPastBack = closesOnSwipeBack
    gestures.reopensPastForward = reopensOnSwipeForward
    gestures.pulls = pullToRefresh
    guard let pageID, failedID != pageID else { return }
    if let page, PhonePages.shared.page(pageID) === page { return }
    unbind()
    let opened: WebTab
    do {
      try PhonePages.shared.open(pageID, url: initialURL, title: title, isPrivate: isPrivate, savedState: savedState)
      guard let live = PhonePages.shared.activate(pageID) else { throw PagePayloads.error("ERR_NO_PAGE", "The page \(pageID) could not be opened") }
      opened = live
    } catch {
      failedID = pageID
      let exception = error as? Exception
      onPageEvent(["name": "error", "code": exception?.code ?? "ERR_PAGE", "message": exception?.reason ?? error.localizedDescription])
      return
    }
    page = opened
    registeredPageID = pageID
    Self.hosts.setObject(self, forKey: pageID as NSString)
    _ = pinchWatcher
    wasLoading = opened.isLoading
    observing += 1
    observe(opened, generation: observing)
  }

  @MainActor
  func unbind() {
    observing += 1
    toneTask?.cancel()
    toneTask = nil
    forgetHostedWebView()
    restoreHiddenCover()
    scrollObservation = nil
    contentSizeObservation = nil
    madeGestures?.detach()
    endPinchNow()
    if let registeredPageID, Self.hosts.object(forKey: registeredPageID as NSString) === self { Self.hosts.removeObject(forKey: registeredPageID as NSString) }
    registeredPageID = nil
    PhoneHandoff.withdraw(self)
    if let hostedWebView, hostedWebView.superview === self { hostedWebView.removeFromSuperview() }
    hostedWebView = nil
    page = nil
    failedID = nil
    sampled = nil
    sentTone = nil
    glassBarDark = nil
    sentBarDark = nil
    sentState = nil
  }

  @MainActor
  private func host(_ webView: WKWebView?) {
    guard webView !== hostedWebView || webView?.superview !== self else { return }
    if let hostedWebView, hostedWebView.superview === self {
      if webView !== hostedWebView, let page { PageLastFrame.keep(hostedWebView, document: page.navigationGeneration) }
      hostedWebView.removeFromSuperview()
    }
    if webView !== hostedWebView {
      endPinchNow()
      forgetHostedWebView()
    }
    hostedWebView = webView
    madePinchWatcher?.zoomer = webView?.scrollView
    scrollObservation = nil
    contentSizeObservation = nil
    guard let webView else {
      gestures.attach(nil, page: nil)
      return
    }
    webView.removeFromSuperview()
    webView.frame = webViewFrame
    webView.autoresizingMask = []
    addSubview(webView)
    hostedAt = CACurrentMediaTime()
    showLastFrame(of: webView)
    if PhoneTestBuild.isOn { NSLog("PAGELAB time page hosted %.0f", Date().timeIntervalSince1970 * 1000) }
    applyObscuredInsets()
    gestures.attach(webView, page: page)
    scrollObservation = webView.scrollView.observe(\.contentOffset, options: []) { [weak self] _, _ in
      MainActor.assumeIsolated { self?.scrollMoved() }
    }
    contentSizeObservation = webView.scrollView.observe(\.contentSize, options: []) { [weak self] _, _ in
      MainActor.assumeIsolated { self?.keepOffsetWithinContent() }
    }
    scheduleToneSample(after: .milliseconds(120))
    reportDrawnSoon()
  }

  @MainActor
  private func forgetHostedWebView() {
    glassBarDark = nil
    removeLastFrame()
    drawnTask?.cancel()
    drawnTask = nil
    drawnSent = false
    drawnDelivered = false
    drawnDocument = nil
    coverCapTask?.cancel()
    coverCapTask = nil
    coverRetryTask?.cancel()
    coverRetryTask = nil
    scrollRestTask?.cancel()
    scrollRestTask = nil
  }

  @MainActor
  private func observe(_ page: WebTab, generation: Int) {
    withObservationTracking {
      update(page)
    } onChange: { [weak self] in
      Task { @MainActor [weak self] in
        guard let self, self.observing == generation, self.page === page else { return }
        self.observe(page, generation: generation)
      }
    }
  }

  @MainActor
  private func update(_ page: WebTab) {
    host(page.webView)
    let state = PhonePages.shared.state(page)
    let comparable = state as NSDictionary
    if comparable != sentState {
      sentState = comparable
      var payload = state
      payload["name"] = "state"
      onPageEvent(payload)
    }
    if !page.isLoading { madeGestures?.pageStoppedLoading() }
    if let session = summarySession, !session.isCurrent(for: page) { dismissSummary(animated: false) }
    if summarySession == nil, pinchIsPending, pinchNavigation != page.navigationGeneration { endPinchNow() }
    if window != nil, !isPrivate { PhoneHandoff.offer(page.url, title: page.title, from: self) } else { PhoneHandoff.withdraw(self) }
    if let drawnDocument, drawnDocument != page.navigationGeneration {
      drawnSent = false
      drawnDelivered = false
      self.drawnDocument = nil
    }
    if wasLoading, !page.isLoading { scheduleToneSample(after: .milliseconds(250)) }
    reportDrawnSoon()
    wasLoading = page.isLoading
    sendTone(theme: page.themeColor, underPage: page.underPageBackgroundColor)
    paintSideMargins()
  }

  @MainActor
  private func sendTone(theme: UIColor?, underPage: UIColor?) {
    let tone = PageTone.resolve(theme: theme, underPage: underPage, sampled: sampled, stored: nil)
    guard GlassToneSend.needed(toneChanged: tone != sentTone, hasColors: tone.top != nil || tone.bottom != nil, barDark: glassBarDark, sentBarDark: sentBarDark) else { return }
    sentTone = tone
    sentBarDark = glassBarDark
    var payload: [String: Any] = ["name": "tone"]
    if let glassBarDark { payload["barDark"] = glassBarDark }
    if let top = tone.top { payload["top"] = top.hex }
    if let bottom = tone.bottom { payload["bottom"] = bottom.hex }
    onPageEvent(payload)
  }

  @MainActor
  private func scrollMoved() {
    if lastFrameView != nil, hostedWebView?.scrollView.isTracking == true { removeLastFrame() }
    keepOffsetWithinContent()
    lastScroll = CACurrentMediaTime()
    scheduleScrollRest()
    guard toneTask == nil else { return }
    toneTask = Task { @MainActor [weak self] in
      while let self, !Task.isCancelled {
        let quiet = CACurrentMediaTime() - self.lastScroll
        if quiet >= 0.16 { break }
        try? await Task.sleep(for: .seconds(max(0.16 - quiet, 0.02)))
      }
      guard let self, !Task.isCancelled else { return }
      self.toneTask = nil
      await self.sampleTone()
    }
  }

  @MainActor
  private func scheduleScrollRest() {
    guard scrollRestTask == nil, let webView = hostedWebView else { return }
    let generation = observing
    scrollRestTask = Task { @MainActor [weak self, weak webView] in
      while let self, let webView, !Task.isCancelled, self.hostedWebView === webView {
        let scroller = webView.scrollView
        let quiet = CACurrentMediaTime() - self.lastScroll
        let held = scroller.isTracking || scroller.isDecelerating || scroller.isZooming
        if quiet >= PageView.scrollRest, !held { break }
        try? await Task.sleep(for: .seconds(max(PageView.scrollRest - quiet, 0.1)))
      }
      guard let self, !Task.isCancelled else { return }
      self.scrollRestTask = nil
      guard let webView, self.shows(webView, since: generation), let pageID = self.registeredPageID else { return }
      let scroller = webView.scrollView
      PhonePages.shared.send(pageID, "page.scrollSettled", ["y": Double(scroller.contentOffset.y + scroller.adjustedContentInset.top)])
    }
  }

  @MainActor
  private func scheduleToneSample(after delay: Duration) {
    toneTask?.cancel()
    toneTask = Task { @MainActor [weak self] in
      try? await Task.sleep(for: delay)
      guard let self, !Task.isCancelled else { return }
      self.toneTask = nil
      await self.sampleTone()
    }
  }

  @MainActor
  private func sampleTone() async {
    guard let page, let webView = hostedWebView, webView.window != nil, !webView.isHidden, webView.url != nil,
          !page.isLoading, madeGestures?.isSwiping != true, showsPageAtRest(webView), webView.bounds.height > toneInsets.top + toneInsets.bottom + ToneSampler.bandHeight * 4 else { return }
    let id = page.id
    guard let tone = await ToneSampler.sample(webView, topInset: toneInsets.top, bottomInset: toneInsets.bottom),
          self.page?.id == id, showsPageAtRest(webView) else { return }
    sampled = tone
    sendTone(theme: page.themeColor, underPage: page.underPageBackgroundColor)
  }

  override func willMove(toWindow newWindow: UIWindow?) {
    super.willMove(toWindow: newWindow)
    guard newWindow == nil else { return }
    MainActor.assumeIsolated {
      if let hostedWebView, hostedWebView.superview === self, let page { PageLastFrame.keep(hostedWebView, document: page.navigationGeneration) }
    }
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    guard window != nil else {
      MainActor.assumeIsolated {
        forgetHostedWebView()
        restoreHiddenCover()
        coverHandedOver = false
        PhoneHandoff.withdraw(self)
        endPinchNow()
      }
      return
    }
    MainActor.assumeIsolated {
      if let page, !isPrivate { PhoneHandoff.offer(page.url, title: page.title, from: self) }
      if let pageID, page != nil { _ = PhonePages.shared.activate(pageID) }
      scheduleToneSample(after: .milliseconds(120))
      reportDrawnSoon()
    }
    if pinsSafeArea { applyObscuredInsets() }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    if let hostedWebView, hostedWebView.superview === self { place(hostedWebView, in: webViewFrame) }
    if pinsSafeArea { applyObscuredInsets() }
    MainActor.assumeIsolated { reportDrawnSoon() }
  }

  override func safeAreaInsetsDidChange() {
    super.safeAreaInsetsDidChange()
    if obscuresSafeTop || pinsSafeArea { applyObscuredInsets() }
  }

  private var restingSafeArea: UIEdgeInsets {
    guard let window else { return .zero }
    var origin = CGPoint.zero
    var view: UIView = self
    while let parent = view.superview {
      origin.x += view.center.x - view.bounds.width * view.layer.anchorPoint.x - parent.bounds.origin.x
      origin.y += view.center.y - view.bounds.height * view.layer.anchorPoint.y - parent.bounds.origin.y
      if parent === window { break }
      view = parent
    }
    let safe = window.safeAreaInsets
    return UIEdgeInsets(
      top: max(safe.top - origin.y, 0),
      left: max(safe.left - origin.x, 0),
      bottom: max(origin.y + bounds.height - window.bounds.height + safe.bottom, 0),
      right: max(origin.x + bounds.width - window.bounds.width + safe.right, 0)
    )
  }

  var effectiveObscuredInsets: UIEdgeInsets {
    let top = (obscuresSafeTop ? safeAreaInsets.top : obscuredInsets.top) + topClearance
    return UIEdgeInsets(top: top, left: 0, bottom: obscuredInsets.bottom, right: 0)
  }

  private var heldSafeArea = UIEdgeInsets.zero

  private func pinnedSafeArea() -> UIEdgeInsets {
    guard pinsSafeArea, let window else { return .zero }
    guard bounds.width <= window.bounds.width + 0.5, bounds.height <= window.bounds.height + 0.5 else { return heldSafeArea }
    heldSafeArea = restingSafeArea
    return heldSafeArea
  }

  private var pinnedSides: UIEdgeInsets {
    let pinned = pinnedSafeArea()
    return UIEdgeInsets(top: 0, left: pinned.left, bottom: 0, right: pinned.right)
  }

  private var webViewFrame: CGRect { bounds.inset(by: pinnedSides) }

  private func paintSideMargins() {
    let shown = pinnedSides.left > 0 || pinnedSides.right > 0
    if sideMargins.isHidden == shown { sideMargins.isHidden = !shown }
    guard shown else { return }
    if sideMargins.frame != bounds { sideMargins.frame = bounds }
    if sideMargins.superview === self, subviews.first !== sideMargins { sendSubviewToBack(sideMargins) }
    let color = page?.underPageBackgroundColor ?? hostedWebView?.underPageBackgroundColor ?? .black
    if sideMargins.backgroundColor != color { sideMargins.backgroundColor = color }
  }

  private func keepOffsetWithinContent() {
    guard let scrollView = hostedWebView?.scrollView, !scrollView.isDragging, !scrollView.isDecelerating, !scrollView.isZooming else { return }
    let insets = scrollView.adjustedContentInset
    let farthest = max(scrollView.contentSize.width - scrollView.bounds.width + insets.right, -insets.left)
    if scrollView.contentOffset.x > farthest + 0.5 { scrollView.contentOffset.x = farthest }
  }

  private func applyObscuredInsets() {
    guard let hostedWebView, hostedWebView.superview === self else { return }
    let pins = pinsSafeArea && window != nil
    let pinned = pins ? pinnedSafeArea() : .zero
    place(hostedWebView, in: webViewFrame)
    paintSideMargins()
    let insets = effectiveObscuredInsets
    if hostedWebView.obscuredContentInsets != insets { hostedWebView.obscuredContentInsets = insets }
    let scrollView = hostedWebView.scrollView
    let adjustment: UIScrollView.ContentInsetAdjustmentBehavior = pins ? .never : .always
    let top = topClearance + pinned.top
    if scrollView.contentInset.top != top || scrollView.contentInset.bottom != pinned.bottom || scrollView.contentInsetAdjustmentBehavior != adjustment {
      let restsAtTop = scrollView.contentOffset.y <= -scrollView.adjustedContentInset.top + 0.5
      scrollView.contentInsetAdjustmentBehavior = adjustment
      scrollView.contentInset.top = top
      scrollView.contentInset.bottom = pinned.bottom
      scrollView.verticalScrollIndicatorInsets.top = topClearance
      if restsAtTop { scrollView.contentOffset.y = -scrollView.adjustedContentInset.top }
    }
  }

  @MainActor
  private func pinchMoment() -> PagePinch.Moment? {
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

  private func place(_ webView: WKWebView, in frame: CGRect) {
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
  private var pinchIsPending: Bool {
    guard let hostedWebView else { return summaryStage != nil }
    return summaryStage != nil || madePinchWatcher?.isHolding == true || hostedWebView.alpha < 1 || !hostedWebView.transform.isIdentity || hostedWebView.layer.masksToBounds
  }

  @MainActor
  private func cancelPendingShot() {
    pageShotRequest += 1
    pageShot = nil
    pageShotWaiters = []
  }

  @MainActor
  private func shootPage() {
    cancelPendingShot()
    guard let webView = hostedWebView else { return deliverShot(nil, request: pageShotRequest) }
    let request = pageShotRequest
    if webView.transform.isIdentity, let copied = PageSnapshots.screenCopy(of: webView, width: webView.bounds.width), !PageSnapshots.isFlat(copied) {
      return deliverShot(copied, request: request)
    }
    webView.takeSnapshot(with: nil) { [weak self, weak webView] image, _ in
      MainActor.assumeIsolated {
        guard let self, self.pageShotRequest == request else { return }
        if let image { return self.deliverShot(image, request: request) }
        guard let webView, webView.bounds.width > 0, webView.bounds.height > 0 else { return self.deliverShot(nil, request: request) }
        let drawn = UIGraphicsImageRenderer(bounds: webView.bounds).image { _ in webView.drawHierarchy(in: webView.bounds, afterScreenUpdates: false) }
        self.deliverShot(drawn, request: request)
      }
    }
  }

  @MainActor
  private func withStatusStrip(_ image: UIImage) -> UIImage {
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
  private func deliverShot(_ image: UIImage?, request: Int) {
    guard request == pageShotRequest else { return }
    let image = image.map(withStatusStrip)
    pageShot = image
    let waiters = pageShotWaiters
    pageShotWaiters = []
    for waiter in waiters { waiter(image) }
    if image != nil, summaryStage == nil, madePinchWatcher?.isHolding == true, let lastHold { pinchHeld(lastHold) }
  }

  @MainActor
  private func whenShot(_ done: @escaping (UIImage?) -> Void) {
    if let pageShot { return done(pageShot) }
    pageShotWaiters.append(done)
  }

  @MainActor
  private func showsPageAtRest(_ webView: WKWebView) -> Bool {
    summaryStage == nil && leaving == nil && madePinchWatcher?.isHolding != true && webView.alpha > 0.99 && webView.transform.isIdentity
  }

  @MainActor
  private static func unpinch(_ webView: WKWebView) {
    webView.layer.removeAllAnimations()
    webView.transform = .identity
    webView.alpha = 1
    webView.layer.cornerRadius = 0
    webView.layer.masksToBounds = false
  }

  @MainActor
  private func restorePage(_ webView: WKWebView) {
    Self.unpinch(webView)
    pinchGround.isHidden = true
    lastHold = nil
    guard webView === hostedWebView, window != nil else { return }
    pinchNavigation = nil
    place(webView, in: webViewFrame)
    scheduleToneSample(after: .milliseconds(120))
  }

  @MainActor
  private func finishLeaving() {
    guard let left = leaving else { return }
    leaving = nil
    left.stage.stop()
    left.stage.removeFromSuperview()
    guard summaryStage == nil, madePinchWatcher?.isHolding != true, let webView = left.webView else { return }
    restorePage(webView)
    if left.wasCommitted, webView === hostedWebView, window != nil { UIAccessibility.post(notification: .screenChanged, argument: webView) }
  }

  @MainActor
  private func endPinchNow() {
    madePinchWatcher?.reset(notifying: false)
    dismissSummary(animated: false)
    guard let hostedWebView, hostedWebView.alpha < 1 || !hostedWebView.transform.isIdentity || hostedWebView.layer.masksToBounds || !pinchGround.isHidden else { return }
    restorePage(hostedWebView)
  }

  private static func pinchTransform(_ hold: PagePinchWatcher.Hold) -> CGAffineTransform {
    CGAffineTransform(scaleX: PagePinch.shownWidthScale(for: hold.scale), y: PagePinch.shownScale(for: hold.scale)).translatedBy(x: hold.shift.x, y: hold.shift.y)
  }

  private static func pinchCorner(_ hold: PagePinchWatcher.Hold) -> CGFloat {
    min(max((1 - PagePinch.shownScale(for: hold.scale)) * 10, 0), 1) * PageSummaryMotion.restingCorner
  }

  @MainActor
  private var summaryLook: PageSummaryLook {
    PageSummaryLook(isPrivate: page?.isPrivate ?? isPrivate, appDark: traitCollection.userInterfaceStyle == .dark)
  }

  @MainActor
  private func showPinchGround(under webView: WKWebView, look: PageSummaryLook) {
    pinchGround.backgroundColor = look.ground
    pinchGround.frame = bounds
    pinchGround.isHidden = false
    insertSubview(pinchGround, belowSubview: webView)
  }

  @MainActor
  private func pinchTaken() {
    guard summaryStage == nil, let webView = hostedWebView else { return }
    lastHold = nil
    pinchNavigation = page?.navigationGeneration
    shootPage()
    showPinchGround(under: webView, look: summaryLook)
    webView.layer.cornerCurve = .continuous
    webView.layer.masksToBounds = true
  }

  @MainActor
  private func raiseStage(_ image: UIImage) -> PageSummaryStage? {
    guard let window, let page, let webView = hostedWebView, webViewFrame.width > 0, webViewFrame.height > 0 else { return nil }
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
  private func pinchHeld(_ hold: PagePinchWatcher.Hold) {
    guard let webView = hostedWebView, summarySession == nil else { return }
    lastHold = hold
    let transform = Self.pinchTransform(hold)
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
  private func pinchLetGo(fired: Bool) {
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
  private func settlePinch(_ webView: WKWebView) {
    guard webView === hostedWebView, window != nil, !UIAccessibility.isReduceMotionEnabled else { return restorePage(webView) }
    lastHold = nil
    UIView.animate(springDuration: 0.6, bounce: 0, options: [.beginFromCurrentState, .allowUserInteraction]) {
      webView.transform = .identity
      webView.layer.cornerRadius = 0
    } completion: { [weak self, weak webView] _ in
      guard let webView else { return }
      guard let self else { return Self.unpinch(webView) }
      guard self.summaryStage == nil, self.leaving == nil, self.madePinchWatcher?.isHolding != true else { return }
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
  private func begin(_ trigger: PageSummarySession.Trigger, on stage: PageSummaryStage) -> Bool {
    guard PageSummarySwitch.shared.isOn, let pageID = registeredPageID, let page, let moment = pinchMoment(), moment.isVisible, !moment.isLoading,
          stageNavigation == page.navigationGeneration else { return false }
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

  @MainActor
  func goBack() -> Bool {
    guard let page, page.canGoBack else { return false }
    page.goBack()
    return true
  }

  @MainActor
  func goForward() -> Bool {
    guard let page, page.canGoForward else { return false }
    page.goForward()
    return true
  }

  @MainActor
  func load(_ address: String) {
    guard let url = URL(string: address) else { return }
    page?.load(url)
  }
}
