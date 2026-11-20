import ArdiaBrowser
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

  private weak var hostedWebView: WKWebView?
  private var failedID: String?
  private var sampled: PageTone?
  private var sentTone: PageTone?
  private var sentState: NSDictionary?
  private var wasLoading = false
  private var observing = 0
  private var toneTask: Task<Void, Never>?
  private var scrollObservation: NSKeyValueObservation?
  private var contentSizeObservation: NSKeyValueObservation?
  private let sideMargins = UIView()
  private var lastScroll: TimeInterval = 0
  private var madeGestures: PageGestures?
  private var madePinchWatcher: PagePinchWatcher?
  private var summaryLayer: PageSummaryLayer?
  private var summaryHideTask: Task<Void, Never>?
  private var registeredPageID: String?

  @MainActor private static let hosts = NSMapTable<NSString, PageView>.strongToWeakObjects()

  @MainActor
  static func host(of pageID: String) -> PageView? {
    guard let view = hosts.object(forKey: pageID as NSString), view.registeredPageID == pageID else { return nil }
    return view
  }

  @MainActor
  static func dismissAllSummaries() {
    for view in hosts.objectEnumerator()?.allObjects.compactMap({ $0 as? PageView }) ?? [] { view.dismissSummary(animated: true) }
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
    made.ignoresTouch = { [weak self] in self?.isSummaryTouch($0) == true }
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
    made.ignoresTouch = { [weak self] in self?.isSummaryTouch($0) == true }
    made.moment = { [weak self] in PageSummarySwitch.shared.isOn ? self?.pinchMoment() : nil }
    made.onPinchedIn = { [weak self] in _ = self?.summarize(.pinch) }
    madePinchWatcher = made
    return made
  }

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    sideMargins.isUserInteractionEnabled = false
    sideMargins.isHidden = true
    addSubview(sideMargins)
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
    scrollObservation = nil
    contentSizeObservation = nil
    madeGestures?.detach()
    madePinchWatcher?.reset()
    dismissSummary(animated: false)
    if let registeredPageID, Self.hosts.object(forKey: registeredPageID as NSString) === self { Self.hosts.removeObject(forKey: registeredPageID as NSString) }
    registeredPageID = nil
    PhoneHandoff.withdraw(self)
    if let hostedWebView, hostedWebView.superview === self { hostedWebView.removeFromSuperview() }
    hostedWebView = nil
    page = nil
    failedID = nil
    sampled = nil
    sentTone = nil
    sentState = nil
  }

  @MainActor
  private func host(_ webView: WKWebView?) {
    guard webView !== hostedWebView || webView?.superview !== self else { return }
    if let hostedWebView, hostedWebView.superview === self { hostedWebView.removeFromSuperview() }
    hostedWebView = webView
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
    if let summaryLayer { bringSubviewToFront(summaryLayer) }
    applyObscuredInsets()
    gestures.attach(webView, page: page)
    scrollObservation = webView.scrollView.observe(\.contentOffset, options: []) { [weak self] _, _ in
      MainActor.assumeIsolated { self?.scrollMoved() }
    }
    contentSizeObservation = webView.scrollView.observe(\.contentSize, options: []) { [weak self] _, _ in
      MainActor.assumeIsolated { self?.keepOffsetWithinContent() }
    }
    scheduleToneSample(after: .milliseconds(120))
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
    if let session = summaryLayer?.presenter.session, !session.isCurrent(for: page) { dismissSummary(animated: false) }
    if window != nil, !isPrivate { PhoneHandoff.offer(page.url, title: page.title, from: self) } else { PhoneHandoff.withdraw(self) }
    if wasLoading, !page.isLoading { scheduleToneSample(after: .milliseconds(250)) }
    wasLoading = page.isLoading
    sendTone(theme: page.themeColor, underPage: page.underPageBackgroundColor)
    paintSideMargins()
  }

  @MainActor
  private func sendTone(theme: UIColor?, underPage: UIColor?) {
    let tone = PageTone.resolve(theme: theme, underPage: underPage, sampled: sampled, stored: nil)
    guard tone != sentTone, tone.top != nil || tone.bottom != nil else { return }
    sentTone = tone
    var payload: [String: Any] = ["name": "tone"]
    if let top = tone.top { payload["top"] = top.hex }
    if let bottom = tone.bottom { payload["bottom"] = bottom.hex }
    onPageEvent(payload)
  }

  @MainActor
  private func scrollMoved() {
    keepOffsetWithinContent()
    lastScroll = CACurrentMediaTime()
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
          !page.isLoading, madeGestures?.isSwiping != true, webView.bounds.height > toneInsets.top + toneInsets.bottom + ToneSampler.bandHeight * 4 else { return }
    let id = page.id
    guard let tone = await ToneSampler.sample(webView, topInset: toneInsets.top, bottomInset: toneInsets.bottom),
          self.page?.id == id else { return }
    sampled = tone
    sendTone(theme: page.themeColor, underPage: page.underPageBackgroundColor)
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    guard window != nil else {
      MainActor.assumeIsolated {
        PhoneHandoff.withdraw(self)
        madePinchWatcher?.reset()
        dismissSummary(animated: false)
      }
      return
    }
    MainActor.assumeIsolated {
      if let page, !isPrivate { PhoneHandoff.offer(page.url, title: page.title, from: self) }
      if let pageID, page != nil { _ = PhonePages.shared.activate(pageID) }
      scheduleToneSample(after: .milliseconds(120))
    }
    if pinsSafeArea { applyObscuredInsets() }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    if let hostedWebView, hostedWebView.superview === self { hostedWebView.frame = webViewFrame }
    if pinsSafeArea { applyObscuredInsets() }
    MainActor.assumeIsolated {
      if let presenter = summaryLayer?.presenter, presenter.bottomInset != summaryBottomInset { presenter.bottomInset = summaryBottomInset }
    }
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
    let frame = webViewFrame
    if hostedWebView.frame != frame { hostedWebView.frame = frame }
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
  private func isSummaryTouch(_ touch: UITouch) -> Bool {
    guard let layer = summaryLayer, let view = touch.view else { return false }
    return view.isDescendant(of: layer)
  }

  private var summaryBottomInset: CGFloat {
    max(effectiveObscuredInsets.bottom, safeAreaInsets.bottom)
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

  @MainActor
  func summarize(_ trigger: PageSummarySession.Trigger) -> Bool {
    guard PageSummarySwitch.shared.isOn, let pageID = registeredPageID, let page, let moment = pinchMoment(), moment.isVisible, !moment.isLoading else { return false }
    if let current = summaryLayer?.presenter.session, current.isCurrent(for: page) {
      if case .failed = current.phase {} else { return true }
    }
    dismissSummary(animated: false)
    let session = PageSummarySession(trigger: trigger, tab: page)
    let isPrivate = page.isPrivate
    session.onSettled = { settled in
      PhonePages.shared.send(pageID, "page.summarySettled", ["trigger": settled.trigger.rawValue, "outcome": settled.outcome, "isPrivate": isPrivate])
    }
    let layer = ensureSummaryLayer()
    summaryHideTask?.cancel()
    layer.isHidden = false
    bringSubviewToFront(layer)
    layer.presenter.bottomInset = summaryBottomInset
    withAnimation(.smooth(duration: 0.32)) { layer.presenter.session = session }
    session.start(page)
    PhonePages.shared.send(pageID, "page.summaryOpened", ["trigger": trigger.rawValue, "isPrivate": isPrivate])
    UIAccessibility.post(notification: .layoutChanged, argument: layer)
    return true
  }

  @MainActor
  private func ensureSummaryLayer() -> PageSummaryLayer {
    if let summaryLayer { return summaryLayer }
    let presenter = PageSummaryPresenter()
    let layer = PageSummaryLayer(presenter: presenter)
    layer.frame = bounds
    layer.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    presenter.onDismiss = { [weak self] in self?.dismissSummary(animated: true) }
    addSubview(layer)
    summaryLayer = layer
    return layer
  }

  @MainActor
  func dismissSummary(animated: Bool) {
    guard let layer = summaryLayer, let session = layer.presenter.session else { return }
    session.cancel()
    layer.presenter.cardFrame = .zero
    summaryHideTask?.cancel()
    guard animated else {
      layer.presenter.session = nil
      layer.isHidden = true
      return
    }
    withAnimation(.smooth(duration: 0.24)) { layer.presenter.session = nil }
    summaryHideTask = Task { @MainActor [weak layer] in
      try? await Task.sleep(for: .milliseconds(300))
      guard !Task.isCancelled, let layer, layer.presenter.session == nil else { return }
      layer.isHidden = true
    }
    UIAccessibility.post(notification: .layoutChanged, argument: hostedWebView)
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
