import ArdiaBrowser
import ArdiaDesign
import SwiftUI
import UIKit
import WebKit

@MainActor
final class PageGestures: NSObject, UIGestureRecognizerDelegate {
  enum Swipe: String {
    case anywhere
    case edges
    case off
  }

  private struct SwipeState {
    var direction: SwipeNavigationDirection
    var isPastHistory: Bool
    var target: UIView
    var shade: UIView
    var isPastCommit = false
  }

  static let commitDistance = Layout.swipeCommit
  static let flickDistance = Layout.swipeFlickCommit
  static let commitHysteresis: CGFloat = 12
  static let parallax = -Layout.swipeParallax
  static let refreshDeadline: Duration = .seconds(8)
  static let edgeWidth: CGFloat = 24

  var swipe: Swipe = .anywhere {
    didSet { if swipe != oldValue { apply() } }
  }

  var pulls = true {
    didSet { if pulls != oldValue { apply() } }
  }

  var closesPastBack = false {
    didSet { if closesPastBack != oldValue { apply() } }
  }

  var reopensPastForward = false {
    didSet { if reopensPastForward != oldValue { apply() } }
  }

  var onSwipedPastHistory: ((SwipeNavigationDirection) -> Void)?
  var ignoresTouch: ((UITouch) -> Bool)?

  var isSwiping: Bool { state != nil }

  private weak var container: UIView?
  private weak var webView: WKWebView?
  private weak var page: WebTab?
  private lazy var pan = UIPanGestureRecognizer(target: self, action: #selector(handleSwipe(_:)))
  private let refreshControl = UIRefreshControl()
  private var state: SwipeState?
  private var animator: UIViewPropertyAnimator?
  private var refreshTimeout: Task<Void, Never>?
  private lazy var refreshFeedback = UIImpactFeedbackGenerator(style: .light, view: container ?? UIView())
  private lazy var swipeFeedback = UIImpactFeedbackGenerator(style: .medium, view: container ?? UIView())

  init(container: UIView) {
    self.container = container
    super.init()
    pan.delegate = self
    pan.maximumNumberOfTouches = 1
    container.addGestureRecognizer(pan)
    refreshControl.tintColor = UIColor(BrowsePalette.loadingBorder)
    refreshControl.addTarget(self, action: #selector(refreshPulled), for: .valueChanged)
  }

  func attach(_ webView: WKWebView?, page: WebTab?) {
    if webView !== self.webView {
      cancel()
      if let old = self.webView, old.scrollView.refreshControl === refreshControl { old.scrollView.refreshControl = nil }
    }
    self.webView = webView
    self.page = page
    apply()
  }

  func detach() {
    cancel()
    endRefreshing()
    if let webView, webView.scrollView.refreshControl === refreshControl { webView.scrollView.refreshControl = nil }
    webView = nil
    page = nil
  }

  func pageStoppedLoading() {
    endRefreshing()
  }

  private func apply() {
    guard let webView else { return }
    webView.allowsBackForwardNavigationGestures = swipe == .edges
    pan.isEnabled = swipe == .anywhere || swipe == .edges && (closesPastBack || reopensPastForward)
    if pulls {
      if webView.scrollView.refreshControl !== refreshControl { webView.scrollView.refreshControl = refreshControl }
    } else if webView.scrollView.refreshControl === refreshControl {
      endRefreshing()
      webView.scrollView.refreshControl = nil
    }
  }

  private func endRefreshing() {
    refreshTimeout?.cancel()
    refreshTimeout = nil
    if refreshControl.isRefreshing { refreshControl.endRefreshing() }
  }

  @objc private func refreshPulled() {
    guard let page else { return endRefreshing() }
    refreshFeedback.impactOccurred()
    page.reload()
    refreshTimeout?.cancel()
    refreshTimeout = Task { @MainActor [weak self] in
      try? await Task.sleep(for: Self.refreshDeadline)
      guard !Task.isCancelled else { return }
      self?.endRefreshing()
    }
  }

  func gestureRecognizer(_ recognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
    ignoresTouch?(touch) != true
  }

  func gestureRecognizerShouldBegin(_ recognizer: UIGestureRecognizer) -> Bool {
    guard recognizer === pan, swipe != .off, let container, let page, let webView, webView.superview === container else { return false }
    let velocity = pan.velocity(in: container)
    guard abs(velocity.x) > abs(velocity.y) * 1.6, abs(velocity.x) > 120 else { return false }
    let back = velocity.x > 0
    let hasHistory = back ? page.canGoBack : page.canGoForward
    let passesHistory = !hasHistory && (back ? closesPastBack : reopensPastForward)
    if swipe == .edges {
      guard passesHistory else { return false }
      let startX = pan.location(in: container).x - pan.translation(in: container).x
      return back ? startX <= Self.edgeWidth : startX >= container.bounds.width - Self.edgeWidth
    }
    guard hasHistory || passesHistory else { return false }
    return !Self.scrollerUnder(pan.location(in: webView), in: webView, canScrollBack: back)
  }

  static func scrollerUnder(_ point: CGPoint, in webView: WKWebView, canScrollBack back: Bool) -> Bool {
    var view = webView.hitTest(point, with: nil)
    while let current = view, current !== webView {
      if let scroller = current as? UIScrollView, scroller.isScrollEnabled, canScroll(scroller, back: back) { return true }
      view = current.superview
    }
    return canScroll(webView.scrollView, back: back)
  }

  static func canScroll(_ scroller: UIScrollView, back: Bool) -> Bool {
    let inset = scroller.adjustedContentInset
    guard scroller.contentSize.width > scroller.bounds.width - inset.left - inset.right + 1 else { return false }
    if back { return scroller.contentOffset.x > -inset.left + 1 }
    return scroller.contentOffset.x + scroller.bounds.width < scroller.contentSize.width + inset.right - 1
  }

  @objc private func handleSwipe(_ recognizer: UIPanGestureRecognizer) {
    guard let container, let webView, let page else { return }
    let width = container.bounds.width
    switch recognizer.state {
    case .began:
      let direction: SwipeNavigationDirection = recognizer.velocity(in: container).x > 0 ? .back : .forward
      let isPastHistory = direction == .back ? !page.canGoBack : !page.canGoForward
      let scrollPan = webView.scrollView.panGestureRecognizer
      scrollPan.isEnabled = false
      scrollPan.isEnabled = true
      let target: UIView
      if !isPastHistory, let image = page.snapshotForSwipe(direction) {
        let imageView = UIImageView(image: image)
        imageView.contentMode = .scaleAspectFill
        imageView.clipsToBounds = true
        target = imageView
      } else {
        target = UIView()
      }
      target.backgroundColor = webView.underPageBackgroundColor ?? .systemBackground
      target.frame = container.bounds
      target.isUserInteractionEnabled = false
      let shade = UIView(frame: container.bounds)
      shade.backgroundColor = UIColor.black.withAlphaComponent(0.12)
      shade.isUserInteractionEnabled = false
      if direction == .back {
        container.insertSubview(target, belowSubview: webView)
        container.insertSubview(shade, aboveSubview: target)
        target.transform = CGAffineTransform(translationX: -width * Self.parallax, y: 0)
      } else {
        container.insertSubview(target, aboveSubview: webView)
        target.transform = CGAffineTransform(translationX: width, y: 0)
        target.layer.shadowColor = UIColor.black.cgColor
        target.layer.shadowOpacity = 0.18
        target.layer.shadowRadius = 12
        target.layer.shadowPath = UIBezierPath(rect: target.bounds).cgPath
        container.insertSubview(shade, belowSubview: target)
      }
      webView.layer.shadowColor = UIColor.black.cgColor
      webView.layer.shadowOpacity = direction == .back ? 0.18 : 0
      webView.layer.shadowRadius = 12
      webView.layer.shadowPath = UIBezierPath(rect: webView.bounds).cgPath
      state = SwipeState(direction: direction, isPastHistory: isPastHistory, target: target, shade: shade)
      swipeFeedback.prepare()
    case .changed:
      guard var state else { return }
      let raw = recognizer.translation(in: container).x
      layout(state, progress: progress(raw, state.direction))
      let signed = state.direction == .back ? raw : -raw
      let isPastCommit = state.isPastCommit ? signed > Self.commitDistance - Self.commitHysteresis : signed > Self.commitDistance
      if isPastCommit != state.isPastCommit {
        state.isPastCommit = isPastCommit
        self.state = state
      }
    case .ended, .cancelled, .failed:
      guard let state else { return }
      let raw = recognizer.translation(in: container).x
      let velocity = recognizer.velocity(in: container).x
      let signed = state.direction == .back ? raw : -raw
      let signedVelocity = state.direction == .back ? velocity : -velocity
      let commits = recognizer.state == .ended && (signed > Self.commitDistance && signedVelocity > -50 || signed > Self.flickDistance && signedVelocity > 600)
      finish(state, commit: commits, velocity: abs(velocity))
    default:
      break
    }
  }

  private func progress(_ translation: CGFloat, _ direction: SwipeNavigationDirection) -> CGFloat {
    let signed = direction == .back ? translation : -translation
    return min(max(signed / max(container?.bounds.width ?? 1, 1), 0), 1)
  }

  private func layout(_ state: SwipeState, progress: CGFloat) {
    guard let webView, let width = container?.bounds.width else { return }
    switch state.direction {
    case .back:
      webView.transform = CGAffineTransform(translationX: width * progress, y: 0)
      state.target.transform = CGAffineTransform(translationX: -width * Self.parallax * (1 - progress), y: 0)
      state.shade.alpha = 1 - progress
    case .forward:
      state.target.transform = CGAffineTransform(translationX: width * (1 - progress), y: 0)
      webView.transform = CGAffineTransform(translationX: -width * Self.parallax * progress, y: 0)
      state.shade.alpha = progress
    }
  }

  private func finish(_ state: SwipeState, commit: Bool, velocity: CGFloat) {
    if commit { swipeFeedback.impactOccurred(intensity: 0.6) }
    let distance = max(container?.bounds.width ?? 1, 1)
    let initial = min(velocity / distance, 6)
    let animator = UIViewPropertyAnimator(duration: 0.22, timingParameters: UISpringTimingParameters(dampingRatio: 1, initialVelocity: CGVector(dx: initial, dy: 0)))
    animator.addAnimations { [self] in layout(state, progress: commit ? 1 : 0) }
    let origin = page
    animator.addCompletion { [weak self] _ in
      guard let self else { return }
      self.animator = nil
      self.webView?.transform = .identity
      self.webView?.layer.shadowOpacity = 0
      state.shade.removeFromSuperview()
      self.state = nil
      guard commit, let page = origin, page === self.page, let container = self.container else {
        state.target.removeFromSuperview()
        return
      }
      container.bringSubviewToFront(state.target)
      state.target.transform = .identity
      state.target.layer.shadowOpacity = 0
      if state.direction == .back ? !page.canGoBack : !page.canGoForward {
        self.onSwipedPastHistory?(state.direction)
      } else if state.direction == .back {
        page.goBack()
      } else {
        page.goForward()
      }
      UIView.animate(withDuration: 0.2, delay: 0.25, options: [.curveEaseOut, .allowUserInteraction]) {
        state.target.alpha = 0
      } completion: { _ in
        state.target.removeFromSuperview()
      }
    }
    self.animator = animator
    animator.startAnimation()
  }

  func cancel() {
    animator?.stopAnimation(true)
    animator = nil
    guard let state else { return }
    state.target.removeFromSuperview()
    state.shade.removeFromSuperview()
    webView?.transform = .identity
    webView?.layer.shadowOpacity = 0
    self.state = nil
  }
}
