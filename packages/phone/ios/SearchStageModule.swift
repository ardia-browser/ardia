import ArdiaDesign
import ExpoModulesCore
import GameController
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
  let onLanding = EventDispatcher()

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
  var landsDirectly = false
  var look = StageMorphLook()
  var corners = StageCorners()
  var cardPlace = StageCardPlace()

  let keyboardSentinel = UIView()
  private var keyboard: StageKeyboardTracker?
  private var keyboardHeight: CGFloat = 0
  private(set) var reduceMotion = UIAccessibility.isReduceMotionEnabled

  private(set) var isShown = false
  var isClosing = false
  private var isDeparting = false
  private var hasLanded = false
  private var isHoldingLift = false
  private var heldLift: CGFloat?
  private var dragOffset: CGFloat = 0
  var releaseVelocity: CGFloat = 0
  private var revealsContents = true
  private var hasRevealed = false
  private var reportedLift: (lift: CGFloat, up: Bool, predicted: Bool)?
  var face: StageFace?
  private var emergence: StageEmergence?
  var morph: StageMorph?
  var fadingMorph: StageMorph?
  var pendingFlight: CGFloat?
  var pendingFallback: Task<Void, Never>?
  private var landingTask: Task<Void, Never>?
  private var releaseTask: Task<Void, Never>?
  var settleTask: Task<Void, Never>?
  var arrivalTask: Task<Void, Never>?
  var settledReported = false
  private var revealDeadline: Task<Void, Never>?
  private var revealHold: Task<Void, Never>?
  private var revealLink: CADisplayLink?
  private var rise: UIViewPropertyAnimator?
  private var anticipatedLift: CGFloat?
  var closingPath = "none"
  private var anticipationTask: Task<Void, Never>?
  private static var keyboardMemory: StageKeyboardMemory?

  private static let keyboardThreshold: CGFloat = 120
  static let keyboardGrace: Duration = .milliseconds(50)
  private static let keyboardAnticipation: Duration = .milliseconds(600)
  static let landingLead: TimeInterval = 0.05
  private static let contentDeadline: Duration = .milliseconds(250)
  private static let contentCap: Duration = .milliseconds(750)
  static let settlePoll: Duration = .milliseconds(16)
  static let settleDeadline: Duration = .milliseconds(1500)
  static let stillReleaseSpeed: CGFloat = 1
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
    let tracker = StageKeyboardTracker(minimumHeight: Self.keyboardThreshold, onMove: { [weak self] move in self?.keyboardWillMove(move) }, onUnchanged: { [weak self] height in self?.keyboardStayed(at: height) })
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
    stopAnticipating()
    landingTask?.cancel()
    releaseTask?.cancel()
    settleTask?.cancel()
    arrivalTask?.cancel()
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

  var panel: SearchStagePanelView? {
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

  var keyboardUp: Bool { keyboardHeight > 0 }
  private var trayHeight: CGFloat { panel?.bounds.height ?? 0 }
  private var isCommandBar: Bool { commandTop != nil }
  private var isUp: Bool { keyboardUp || (!isClosing && hasLanded) }
  private var offscreenDrop: CGFloat { trayHeight + BrowseLayout.sheetTopRadius }
  private var safeBottom: CGFloat { window?.safeAreaInsets.bottom ?? 0 }

  private var liveLift: CGFloat {
    let restsWithoutKeyboard = hasLanded && !keyboardUp && !isClosing
    return restsWithoutKeyboard ? max(anticipatedLift ?? keyboardHeight, safeBottom) : keyboardHeight
  }

  private func stopAnticipating() {
    anticipationTask?.cancel()
    anticipationTask = nil
    anticipatedLift = nil
  }

  var card: CGRect {
    CGRect(x: cardPlace.cardInset, y: 0, width: (panel?.bounds.width ?? 0) - 2 * cardPlace.cardInset, height: max(trayHeight - cardPlace.cardGap, 0))
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
    arrivalTask?.cancel()
    stopAnticipating()
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
    DispatchQueue.main.async { [weak self] in self?.startIfLaidOut() }
  }

  private func startIfLaidOut() {
    guard isShown, !isStarted, !isClosing, contentIsLaidOut || contentGaveUp, let panel else { return }
    isStarted = true
    holdReveals()
    if let anchor = pendingAnchor, !keyboardUp, !isCommandBar, !reduceMotion {
      revealsContents = false
      emergence = StageEmergence(pill: convert(anchor.frame, from: nil), fieldCenter: fieldCenter, corners: corners, place: cardPlace, face: face?.makeView(), on: panel)
    }
    pendingAnchor = nil
    place()
    focusField()
    releaseStartWaiters()
    guard !hasLanded else { return }
    if focusNativeId != nil, !isCommandBar, let predicted = predictedKeyboardHeight {
      anticipatedLift = predicted
      anticipationTask = Task { [weak self] in
        try? await Task.sleep(for: Self.keyboardAnticipation)
        guard let self, !Task.isCancelled, self.isShown, !self.isClosing, self.anticipatedLift != nil, !self.keyboardUp else { return }
        self.settleWithoutKeyboard()
      }
    }
    rise = move(.timing(reduceMotion ? Motion.stageReduced : Motion.riseCurve)) { [self] in self.hasLanded = true }
  }

  private var keyboardGeometry: StageKeyboardGeometry? {
    guard let window, let scene = window.windowScene else { return nil }
    return StageKeyboardGeometry(window: ObjectIdentifier(window), windowSize: window.bounds.size, orientation: scene.effectiveGeometry.interfaceOrientation)
  }

  private var predictedKeyboardHeight: CGFloat? {
    guard GCKeyboard.coalesced == nil, let memory = Self.keyboardMemory, let geometry = keyboardGeometry, memory.geometry == geometry else { return nil }
    return memory.height
  }

  private func stopRise() {
    if let rise, rise.isRunning {
      UIView.performWithoutAnimation { rise.stopAnimation(true) }
    }
    rise = nil
  }

  private func settleWithoutKeyboard() {
    anticipationTask?.cancel()
    anticipationTask = nil
    guard anticipatedLift != nil else { return }
    stopRise()
    move(.spring(Motion.smoothSpring, velocity: 0)) { [self] in self.anticipatedLift = nil }
  }

  private func keyboardStayed(at height: CGFloat) {
    guard window != nil, height == 0, isShown, !isClosing, anticipatedLift != nil else { return }
    if searchFieldFocused { Self.keyboardMemory = nil }
    settleWithoutKeyboard()
  }

  private var searchFieldFocused: Bool {
    guard let id = focusNativeId, let field = Self.find(nativeId: id, in: self) as? CompletingFieldView else { return false }
    return field.field.isFirstResponder
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
    settledReported = false
    if anticipatedLift != nil, !keyboardUp { heldLift = heldLift ?? liveLift }
    stopAnticipating()
    landingTask?.cancel()
    releaseTask?.cancel()
    foldDragIntoStage()
    releaseVelocity = velocity
    defer { releaseVelocity = 0 }
    let shownSurface = emergence.flatMap { emergence in panel.map { emergence.shownSurface(of: $0, card: card, in: self) } }
    endEmergence()
    closingPath = exit.rawValue
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
    if exit == .morph, reduceMotion || isCommandBar { reportLanding(false, path: "morphSkipped") }
    if PhoneTestBuild.isOn { traceOverAnchor("close \(exit.rawValue)") }
    watchSettling()
  }

  func finish() {
    if PhoneTestBuild.isOn { traceOverAnchor("finish") }
    releaseStartWaiters()
    stopAnticipating()
    landingTask?.cancel()
    releaseTask?.cancel()
    settleTask?.cancel()
    arrivalTask?.cancel()
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

  private func keyboardWillMove(_ move: StageKeyboardMove) {
    guard window != nil else { return }
    let height = move.height
    if height > 0, isShown, !isClosing, searchFieldFocused, let geometry = keyboardGeometry { Self.keyboardMemory = StageKeyboardMemory(height: height, geometry: geometry) }
    stopAnticipating()
    keyboardHeight = height
    if isShown, keyboardUp, !isClosing, !hasLanded {
      landingTask?.cancel()
      hasLanded = true
    }
    stopRise()
    if !isHoldingLift, let held = heldLift, abs(liveLift - held) < 2 {
      heldLift = nil
    }
    if move.duration > 0 {
      UIView.animate(withDuration: move.duration, delay: 0, options: [UIView.AnimationOptions(rawValue: move.curve << 16), .beginFromCurrentState, .allowUserInteraction], animations: { [self] in
        self.keyboardSentinel.center.y = height
        self.place()
      })
    } else {
      UIView.performWithoutAnimation {
        self.keyboardSentinel.center.y = height
        self.place()
      }
    }
    if let velocity = pendingFlight, !keyboardUp { flyMorph(velocity: velocity) }
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

  enum Curve {
    case immediate
    case spring(Spring, velocity: CGFloat)
    case timing(ArdiaDesign.MotionCurve)
  }

  @discardableResult
  func move(_ curve: Curve, _ changes: @escaping () -> Void) -> UIViewPropertyAnimator? {
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
    let predicted = anticipatedLift != nil && !keyboardUp
    if reportedLift?.lift != lift || reportedLift?.up != up || reportedLift?.predicted != predicted {
      reportedLift = (lift, up, predicted)
      onLift(["lift": lift, "up": up, "predicted": predicted])
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
