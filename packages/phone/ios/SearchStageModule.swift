import ArdiaDesign
import ExpoModulesCore
import QuartzCore
import SwiftUI
import UIKit

final class SearchStagePanelView: ExpoView {
  var takesTouches = true
  var onResize: (() -> Void)?
  private var placedSize: CGSize = .zero

  var content: UIView? {
    subviews.first { !($0 is UIImageView) }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    guard bounds.size != placedSize else { return }
    placedSize = bounds.size
    onResize?()
  }

  override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
    takesTouches ? super.hitTest(point, with: event) : nil
  }
}

final class SearchStageView: ExpoView {
  enum Exit: String {
    case morph
    case depart
    case drop
  }

  let onLift = EventDispatcher()
  let onReveal = EventDispatcher()
  let onSettled = EventDispatcher()

  var shownProp = false
  private var appliedShown = false
  var anchorNativeId: String?
  var faceNativeId: String?
  var focusNativeId: String?
  var revealNativeId: String?
  var rowsRevealNativeId: String?
  var focusPending = false
  private var contentIsLate = false
  private(set) var isStarted = false
  private var contentGaveUp = false
  private var pendingAnchor: StageAnchor?
  private var startWaiters: [() -> Void] = []
  var fieldCenter = BrowseLayout.stageFieldCenter(fieldHeight: BrowseLayout.searchFieldHeight)
  var commandTop: CGFloat?
  var look = StageMorphLook()

  private let keyboardSentinel = UIView()
  private var keyboard: StageKeyboardTracker?
  private var keyboardHeight: CGFloat = 0
  private(set) var reduceMotion = UIAccessibility.isReduceMotionEnabled

  private(set) var isShown = false
  private(set) var isClosing = false
  private var isDeparting = false
  private var hasLanded = false
  private var isHoldingLift = false
  private var heldLift: CGFloat?
  private var dragOffset: CGFloat = 0
  private var releaseVelocity: CGFloat = 0
  private var revealsContents = true
  private var hasRevealed = false
  private var reportedLift: (lift: CGFloat, up: Bool)?
  private var face: StageFace?
  private var emergence: StageEmergence?
  private var morph: StageMorph?
  private var fadingMorph: StageMorph?
  private var pendingFlight: CGFloat?
  private var pendingFallback: Task<Void, Never>?
  private var landingTask: Task<Void, Never>?
  private var releaseTask: Task<Void, Never>?
  private var settleTask: Task<Void, Never>?
  private var revealDeadline: Task<Void, Never>?
  private var revealHold: Task<Void, Never>?
  private var revealLink: CADisplayLink?
  private var rise: UIViewPropertyAnimator?

  private static let keyboardThreshold: CGFloat = 120
  private static let keyboardWait: Duration = .milliseconds(220)
  private static let keyboardGrace: Duration = .milliseconds(50)
  private static let contentDeadline: Duration = .milliseconds(250)
  private static let contentCap: Duration = .milliseconds(750)
  private static let settlePoll: Duration = .milliseconds(16)
  private static let settleDeadline: Duration = .milliseconds(1500)
  private static let stillReleaseSpeed: CGFloat = 1
  private static let commandBarTuckedScale: CGFloat = 0.96

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    backgroundColor = .clear
    keyboardSentinel.isHidden = true
    keyboardSentinel.isUserInteractionEnabled = false
    addSubview(keyboardSentinel)
    NotificationCenter.default.addObserver(self, selector: #selector(reduceMotionChanged), name: UIAccessibility.reduceMotionStatusDidChangeNotification, object: nil)
  }

  deinit {
    NotificationCenter.default.removeObserver(self)
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    guard window != nil else {
      keyboard?.stop()
      keyboard = nil
      tearDown()
      return
    }
    guard keyboard == nil else { return }
    let tracker = StageKeyboardTracker(minimumHeight: Self.keyboardThreshold) { [weak self] height in self?.keyboardWillMove(to: height) }
    tracker.start()
    keyboard = tracker
  }

  private func releaseStartWaiters() {
    let waiters = startWaiters
    startWaiters = []
    waiters.forEach { $0() }
  }

  private func tearDown() {
    releaseStartWaiters()
    landingTask?.cancel()
    releaseTask?.cancel()
    settleTask?.cancel()
    revealHold?.cancel()
    stopWaitingForContent()
    cancelPendingFlight()
    dropMorph()
    if let panel { emergence?.end(on: panel) }
    emergence = nil
    keyboardHeight = 0
    isShown = false
    isClosing = false
    isDeparting = false
    hasLanded = false
    heldLift = nil
    dragOffset = 0
  }

  @objc private func reduceMotionChanged() {
    reduceMotion = UIAccessibility.isReduceMotionEnabled
  }

  private var panel: SearchStagePanelView? {
    subviews.lazy.compactMap { $0 as? SearchStagePanelView }.first
  }

  override func didAddSubview(_ subview: UIView) {
    super.didAddSubview(subview)
    if let panel = subview as? SearchStagePanelView {
      panel.onResize = { [weak self] in self?.place() }
      place()
    }
    if subview !== keyboardSentinel, keyboardSentinel.superview === self { bringSubviewToFront(keyboardSentinel) }
  }

  override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
    guard isShown else { return nil }
    if isClosing { return bounds.contains(point) ? self : nil }
    let hit = super.hitTest(point, with: event)
    return hit === self ? nil : hit
  }

  func propsDidUpdate() {
    let turnedOn = shownProp && !appliedShown
    let turnedOff = !shownProp && appliedShown
    appliedShown = shownProp
    if turnedOn {
      present()
    } else if turnedOff, isShown {
      finish()
    } else {
      place()
    }
  }

  private var keyboardUp: Bool { keyboardHeight > 0 }
  private var trayHeight: CGFloat { panel?.bounds.height ?? 0 }
  private var isCommandBar: Bool { commandTop != nil }
  private var isUp: Bool { keyboardUp || (!isClosing && hasLanded) }
  private var offscreenDrop: CGFloat { trayHeight + BrowseLayout.sheetTopRadius }
  private var safeBottom: CGFloat { window?.safeAreaInsets.bottom ?? 0 }

  private var liveLift: CGFloat {
    let restsWithoutKeyboard = hasLanded && !keyboardUp && !isClosing
    return restsWithoutKeyboard ? max(keyboardHeight, safeBottom) : keyboardHeight
  }

  private var card: CGRect {
    CGRect(x: BrowseLayout.panelInset, y: 0, width: (panel?.bounds.width ?? 0) - 2 * BrowseLayout.panelInset, height: max(trayHeight - BrowseLayout.panelAboveKeyboard, 0))
  }

  private var trayOffset: CGFloat {
    let departure = isDeparting ? -BrowseLayout.stageDepartLift : 0
    guard !isCommandBar else { return dragOffset + departure }
    if let emergence, !isUp, !isClosing {
      return emergence.restingOffset(trayHeight: trayHeight, stageBottom: bounds.maxY) + dragOffset
    }
    let restingDrop = isUp || isDeparting || reduceMotion ? 0 : offscreenDrop
    return -(heldLift ?? liveLift) + dragOffset + restingDrop + departure
  }

  private var trayAlpha: CGFloat {
    if !isStarted || isDeparting || morph?.isShown == true { return 0 }
    return isUp || (!reduceMotion && !isCommandBar) ? 1 : 0
  }

  var hasSettled: Bool {
    guard !keyboardUp, pendingFlight == nil else { return false }
    guard let morph else { return !isAnimating }
    return !morph.isMoving
  }

  private var isAnimating: Bool {
    [panel?.layer, keyboardSentinel.layer].contains { !(($0?.animationKeys()) ?? []).isEmpty }
  }

  func present(onStarted: (() -> Void)? = nil) {
    appliedShown = true
    guard !isShown || isClosing else {
      if isStarted { onStarted?() } else if let onStarted { startWaiters.append(onStarted) }
      focusField()
      return
    }
    startWaiters.forEach { $0() }
    startWaiters = onStarted.map { [$0] } ?? []
    landingTask?.cancel()
    releaseTask?.cancel()
    settleTask?.cancel()
    dropMorph()
    endEmergence()
    let anchor = resolveAnchor()
    face = anchor.flatMap(renderFace(of:))
    pendingAnchor = anchor
    move(.immediate) { [self] in
      isShown = true
      isStarted = false
      isClosing = false
      isDeparting = false
      hasLanded = keyboardUp
      dragOffset = 0
      heldLift = nil
      isHoldingLift = false
      hasRevealed = false
      revealsContents = true
    }
    holdReveals()
    contentIsLate = false
    contentGaveUp = false
    focusPending = focusNativeId != nil
    startWaitingForContent()
    startIfLaidOut()
  }

  private func startIfLaidOut() {
    guard isShown, !isStarted, !isClosing, contentIsLaidOut || contentGaveUp, let panel else { return }
    isStarted = true
    holdReveals()
    if let anchor = pendingAnchor, !keyboardUp, !isCommandBar, !reduceMotion {
      revealsContents = false
      emergence = StageEmergence(pill: convert(anchor.frame, from: nil), fieldCenter: fieldCenter, face: face?.makeView(), on: panel)
    }
    pendingAnchor = nil
    place()
    focusField()
    releaseStartWaiters()
    guard !hasLanded else { return }
    landingTask = Task { [weak self] in
      try? await Task.sleep(for: Self.keyboardWait)
      guard let self, !Task.isCancelled, isShown, !isClosing, !hasLanded else { return }
      rise = move(.timing(reduceMotion ? Motion.stageReduced : Motion.riseCurve)) { [self] in self.hasLanded = true }
    }
  }

  func holdLift() {
    guard isShown, !isClosing else { return }
    releaseTask?.cancel()
    isHoldingLift = true
    if heldLift == nil { heldLift = liveLift }
  }

  func releaseLift() {
    isHoldingLift = false
    guard heldLift != nil, !isClosing else { return }
    move(.spring(Motion.smoothSpring, velocity: 0)) { [self] in heldLift = nil }
  }

  func close(_ exit: Exit, velocity: CGFloat) {
    guard isShown, !isClosing else { return }
    landingTask?.cancel()
    releaseTask?.cancel()
    foldDragIntoStage()
    releaseVelocity = velocity
    defer { releaseVelocity = 0 }
    let shownSurface = emergence.flatMap { emergence in panel.map { emergence.shownSurface(of: $0, card: card, in: self) } }
    endEmergence()
    if exit == .morph, !reduceMotion, !isCommandBar {
      beginMorph(from: shownSurface)
    } else if exit == .depart, !reduceMotion {
      heldLift = heldLift ?? liveLift
      move(.timing(Motion.stageDepartCurve)) { [self] in
        isClosing = true
        isDeparting = true
      }
    } else if keyboardUp, heldLift == nil {
      move(.immediate) { [self] in isClosing = true }
    } else {
      let travel = trayHeight + (heldLift ?? 0) + BrowseLayout.sheetTopRadius
      let slidesOut = heldLift != nil && !reduceMotion
      let distance = (slidesOut ? max(travel - dragOffset, 0) : 0) + (reduceMotion ? 0 : offscreenDrop)
      let relative = Motion.relativeVelocity(releaseVelocity, over: distance)
      move(reduceMotion ? .timing(Motion.stageReduced) : .spring(Motion.leaveSpring, velocity: relative)) { [self] in
        isClosing = true
        if slidesOut { dragOffset = max(dragOffset, travel) }
      }
    }
    watchSettling()
  }

  func finish() {
    releaseStartWaiters()
    landingTask?.cancel()
    releaseTask?.cancel()
    settleTask?.cancel()
    stopWaitingForContent()
    handOffMorph()
    endEmergence()
    move(.immediate) { [self] in
      isShown = false
      isClosing = false
      isDeparting = false
      hasLanded = false
      dragOffset = 0
      heldLift = nil
      isHoldingLift = false
    }
  }

  private func foldDragIntoStage() {
    guard let content = panel?.content else { return }
    let shown = (content.layer.presentation() ?? content.layer).affineTransform().ty
    guard shown != 0 else { return }
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    content.layer.removeAllAnimations()
    content.layer.setAffineTransform(.identity)
    dragOffset = max(dragOffset + shown, 0)
    place()
    CATransaction.commit()
  }

  private func watchSettling() {
    settleTask?.cancel()
    settleTask = Task { [weak self] in
      guard let self else { return }
      guard await StageSettlePoll.until(every: Self.settlePoll, within: Self.settleDeadline, { self.hasSettled }), isClosing else { return }
      onSettled(["landed": morph?.hasDestination == true])
    }
  }

  private func keyboardWillMove(to height: CGFloat) {
    guard window != nil else { return }
    keyboardHeight = height
    if isShown, keyboardUp, !isClosing, !hasLanded {
      landingTask?.cancel()
      hasLanded = true
    }
    if let rise, rise.isRunning {
      UIView.performWithoutAnimation { rise.stopAnimation(true) }
    }
    rise = nil
    if !isHoldingLift, let held = heldLift, abs(liveLift - held) < 2 {
      heldLift = nil
    }
    keyboardSentinel.center.y = height
    place()
    if let velocity = pendingFlight, !keyboardUp { flyMorph(velocity: velocity) }
  }

  private func beginMorph(from shownSurface: StageMorph.Start?) {
    guard let panel else { return }
    morph = StageMorph(card: card, fieldCenter: fieldCenter, of: panel, in: self, look: look, from: shownSurface)
    move(.immediate) { [self] in
      isClosing = true
      if !keyboardUp { morph?.appear() }
    }
    pendingFlight = releaseVelocity
    DispatchQueue.main.async { [weak self] in self?.launchMorph() }
  }

  private func launchMorph() {
    guard let velocity = pendingFlight else { return }
    guard keyboardUp else {
      flyMorph(velocity: velocity)
      return
    }
    pendingFallback?.cancel()
    pendingFallback = Task { [weak self] in
      try? await Task.sleep(for: Self.keyboardGrace)
      guard let self, !Task.isCancelled, let velocity = pendingFlight else { return }
      flyMorph(velocity: velocity)
    }
  }

  private func flyMorph(velocity: CGFloat) {
    cancelPendingFlight()
    guard let morph else { return }
    guard let anchor = resolveAnchor() else {
      morph.vanish()
      hidePanelUnderMorph()
      return
    }
    let target = convert(anchor.frame, from: nil)
    let carried = face.flatMap { $0.fits(anchor) ? $0 : nil }
    if abs(velocity) < Self.stillReleaseSpeed, let clock = StageKeyboardClock(layer: keyboardSentinel.layer) {
      morph.fly(to: target, style: anchor.style, carrying: carried, timing: clock.timing, duration: clock.duration)
    } else {
      let distance = target.midY - morph.view.frame.midY
      let timing = Motion.smoothSpring.stageTimingParameters(initialVelocity: Motion.relativeVelocity(velocity, over: distance))
      morph.fly(to: target, style: anchor.style, carrying: carried, timing: timing, duration: Motion.smoothSpring.settlingDuration)
    }
    hidePanelUnderMorph()
  }

  private func cancelPendingFlight() {
    pendingFallback?.cancel()
    pendingFallback = nil
    pendingFlight = nil
  }

  private func hidePanelUnderMorph() {
    UIView.performWithoutAnimation { panel?.alpha = 0 }
  }

  private func handOffMorph() {
    cancelPendingFlight()
    fadingMorph?.remove()
    fadingMorph = morph
    morph?.handOff()
    morph = nil
  }

  private func dropMorph() {
    cancelPendingFlight()
    morph?.remove()
    morph = nil
    fadingMorph?.remove()
    fadingMorph = nil
  }

  private func endEmergence() {
    revealHold?.cancel()
    revealHold = nil
    if let panel { emergence?.end(on: panel) }
    emergence = nil
    if !revealsContents { revealsContents = true }
    revealIfReady()
  }

  private func startWaitingForContent() {
    stopWaitingForContent()
    revealDeadline = Task { [weak self] in
      try? await Task.sleep(for: Self.contentDeadline)
      guard let self, !Task.isCancelled, isShown, !hasRevealed else { return }
      if !contentIsLaidOut, PhoneTestBuild.isOn { NSLog("ARDIA_SEARCH_STAGE content not laid out 250 ms after shown") }
      contentIsLate = !contentIsLaidOut
      revealIfReady()
      try? await Task.sleep(for: Self.contentCap)
      guard !Task.isCancelled, isShown, !isStarted else { return }
      contentGaveUp = true
      startIfLaidOut()
    }
    let link = CADisplayLink(target: self, selector: #selector(contentTick))
    link.add(to: .main, forMode: .common)
    revealLink = link
  }

  private func stopWaitingForContent() {
    revealDeadline?.cancel()
    revealDeadline = nil
    revealLink?.invalidate()
    revealLink = nil
  }

  @objc private func contentTick() {
    startIfLaidOut()
    focusField()
    revealIfReady()
  }

  private var contentIsLaidOut: Bool {
    guard let content = panel?.content else { return false }
    return content.bounds.width > 0 && content.bounds.height > 0
  }

  private func revealIfReady() {
    guard isShown, isStarted, !hasRevealed, revealsContents, contentIsLaidOut || contentIsLate else { return }
    reveal(late: contentIsLate)
  }

  private func reveal(late: Bool) {
    guard !hasRevealed else { return }
    hasRevealed = true
    stopWaitingForContent()
    let base = CACurrentMediaTime()
    emergence?.fadeFace(from: base)
    fadeInReveals(from: base)
    onReveal(["late": late])
    place()
  }

  private func revealContentsAfterUnfold() {
    guard !revealsContents, revealHold == nil else { return }
    revealHold = Task { [weak self] in
      try? await Task.sleep(for: .seconds(Motion.stageRevealHold))
      guard let self, !Task.isCancelled, !revealsContents else { return }
      revealsContents = true
      revealIfReady()
    }
  }

  private enum Curve {
    case immediate
    case spring(Spring, velocity: CGFloat)
    case timing(ArdiaDesign.MotionCurve)
  }

  @discardableResult
  private func move(_ curve: Curve, _ changes: @escaping () -> Void) -> UIViewPropertyAnimator? {
    switch curve {
    case .immediate:
      UIView.performWithoutAnimation {
        changes()
        place()
      }
      return nil
    case .spring(let spring, let velocity):
      UIView.animate(springDuration: spring.duration, bounce: spring.bounce, initialSpringVelocity: velocity, delay: 0, options: [.allowUserInteraction]) {
        changes()
        self.place()
      }
      return nil
    case .timing(let timing):
      let animator = timing.stageAnimator {
        changes()
        self.place()
      }
      animator.startAnimation()
      return animator
    }
  }

  private func place() {
    guard window != nil, let panel, panel.window != nil else { return }
    let lift = heldLift ?? liveLift
    let scale: CGFloat = isCommandBar && !isUp && !reduceMotion ? Self.commandBarTuckedScale : 1
    let height = panel.bounds.height
    let pivot = isCommandBar ? -height / 2 : height / 2
    panel.isHidden = !isShown
    panel.transform = CGAffineTransform(a: scale, b: 0, c: 0, d: scale, tx: 0, ty: trayOffset + pivot * (1 - scale))
    panel.alpha = trayAlpha
    placeEmergence(on: panel)
    let isUnrevealed = !isStarted || (emergence != nil && !isUp)
    panel.takesTouches = isShown && !isClosing && !isUnrevealed
    panel.accessibilityElementsHidden = isUnrevealed
    accessibilityViewIsModal = isShown
    panel.accessibilityViewIsModal = isShown
    let up = isShown && isUp
    if reportedLift?.lift != lift || reportedLift?.up != up {
      reportedLift = (lift, up)
      onLift(["lift": lift, "up": up])
    }
  }

  private func placeEmergence(on panel: UIView) {
    guard let emergence else { return }
    emergence.place(on: panel, in: self, card: card, isOpen: isUp)
    guard isUp else { return }
    emergence.whenSettled { [weak self] in self?.endEmergence() }
    revealContentsAfterUnfold()
  }
}
