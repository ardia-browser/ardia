import ArdiaDesign
import Observation
import SwiftUI
import UIKit

@MainActor
@Observable
final class TrayMotion {
  private(set) var lift: CGFloat = 0
  private(set) var revealsContents = true
  private(set) var isClosing = false
  var isFocused = false
  @ObservationIgnored var reduceMotion = false
  @ObservationIgnored var barAnchor: () -> BarAnchor? = { nil }
  @ObservationIgnored var barFace: BarFaceImage?
  @ObservationIgnored private(set) lazy var controller: TrayStageController = {
    let controller = TrayStageController()
    controller.onResize = { [weak self] in self?.place() }
    return controller
  }()
  @ObservationIgnored private var isDragging = false
  @ObservationIgnored private var heldLift: CGFloat?
  @ObservationIgnored private var releaseVelocity: CGFloat = 0
  @ObservationIgnored private var keyboard: KeyboardTracker?
  @ObservationIgnored private var keyboardHeight: CGFloat = 0
  @ObservationIgnored private var isShown = false
  @ObservationIgnored private var isDeparting = false
  @ObservationIgnored private var hasLanded = false
  @ObservationIgnored private var dragOffset: CGFloat = 0
  @ObservationIgnored private var grabbedAt: CGFloat = 0
  @ObservationIgnored private var dimLevel: CGFloat = 0
  @ObservationIgnored private var dimShown = false
  @ObservationIgnored private var landingTask: Task<Void, Never>?
  @ObservationIgnored private var rise: UIViewPropertyAnimator?
  @ObservationIgnored private var releaseTask: Task<Void, Never>?
  @ObservationIgnored private var fieldCenter = BrowseLayout.panelFieldCenter(fieldHeight: BrowseLayout.searchFieldHeight)
  @ObservationIgnored private var emergence: TrayEmergence?
  @ObservationIgnored private var morph: TrayMorph?
  @ObservationIgnored private var fadingMorph: TrayMorph?
  @ObservationIgnored private var pendingFlight: PendingFlight?

  private static let keyboardThreshold: CGFloat = 120
  private static let keyboardWait: Duration = .milliseconds(220)
  private static let keyboardGrace: Duration = .milliseconds(50)
  private static let heldLiftGrace: Duration = .milliseconds(650)
  private static let heldLiftTolerance: CGFloat = 2
  private static let stillReleaseSpeed: CGFloat = 1
  private static let commandBarTuckedScale: CGFloat = 0.96

  enum Release {
    case dismiss
    case stay
  }

  private enum Curve {
    case immediate
    case spring(Spring, velocity: CGFloat)
    case timing(MotionCurve)
  }

  private struct PendingFlight {
    let velocity: CGFloat
    var fallback: Task<Void, Never>?
  }

  private var keyboardUp: Bool { keyboardHeight > 0 }
  private var trayHeight: CGFloat { controller.trayHeight }
  var isFlyingToBar: Bool { morph?.hasDestination == true }

  var hasSettled: Bool {
    guard !keyboardUp, pendingFlight == nil else { return false }
    guard let morph else { return !controller.isAnimating }
    return !morph.isMoving
  }

  func startTrackingKeyboard() {
    guard keyboard == nil else { return }
    keyboard = KeyboardTracker(minimumHeight: Self.keyboardThreshold) { [weak self] height in
      self?.keyboardWillMove(to: height)
    }
    keyboard?.start()
  }

  func present(dimLevel: CGFloat, onDimTap: @escaping () -> Void) {
    landingTask?.cancel()
    releaseTask?.cancel()
    dropMorph()
    controller.dim.onTap = onDimTap
    move(.immediate) { [self] in
      self.dimLevel = dimLevel
      isShown = true
      isClosing = false
      isDeparting = false
      hasLanded = keyboardUp
      dragOffset = 0
      heldLift = nil
      isDragging = false
    }
    guard !hasLanded else { return }
    landingTask = Task { [weak self] in
      try? await Task.sleep(for: Self.keyboardWait)
      guard let self, !Task.isCancelled, isShown, !isClosing, !hasLanded else { return }
      rise = move(.timing(reduceMotion ? Motion.reducedMotionCurve : Motion.riseCurve)) { [self] in self.hasLanded = true }
    }
  }

  func emerge(from anchor: BarAnchor?, fieldCenter: CGFloat) {
    self.fieldCenter = fieldCenter
    endEmergence()
    guard let anchor, !keyboardUp, !isCommandBar else { return }
    revealsContents = false
    emergence = TrayEmergence(pill: controller.view.convert(anchor.frame, from: nil), fieldCenter: fieldCenter, face: face(fitting: anchor)?.makeView(), on: controller.tray)
  }

  func close(_ exit: TrayExit) {
    landingTask?.cancel()
    releaseTask?.cancel()
    defer { releaseVelocity = 0 }
    let shownSurface = emergence.map { $0.shownSurface(of: controller.tray, card: card, in: controller.view) }
    endEmergence()
    if case .morph(let look) = exit, !reduceMotion, !isCommandBar {
      beginMorph(look: look, from: shownSurface)
    } else if case .depart = exit, !reduceMotion {
      heldLift = heldLift ?? liveLift
      move(.timing(Motion.departCurve)) { [self] in
        isClosing = true
        isDeparting = true
      }
    } else if keyboardUp, heldLift == nil {
      move(.immediate) { [self] in isClosing = true }
    } else {
      let travel = trayHeight + (heldLift ?? 0) + BrowseLayout.sheetTopRadius
      let slidesOut = heldLift != nil && !reduceMotion
      let distance = (slidesOut ? max(travel - dragOffset, 0) : 0) + (reduceMotion ? 0 : offscreenDrop)
      let velocity = Motion.relativeVelocity(releaseVelocity, over: distance)
      move(reduceMotion ? .timing(Motion.reducedMotionCurve) : .spring(Motion.leaveSpring, velocity: velocity)) { [self] in
        isClosing = true
        if slidesOut { dragOffset = max(dragOffset, travel) }
      }
    }
  }

  func finish() {
    landingTask?.cancel()
    releaseTask?.cancel()
    handOffMorph()
    endEmergence()
    move(.immediate) { [self] in
      isShown = false
      isClosing = false
      isDeparting = false
      hasLanded = false
      dragOffset = 0
      heldLift = nil
      isDragging = false
    }
  }

  func dragChanged(translation: CGFloat, releasingKeyboard: Bool) {
    if !isDragging {
      isDragging = true
      endEmergence()
      releaseTask?.cancel()
      grabbedAt = grabMidSpring()
    }
    if releasingKeyboard, heldLift == nil { heldLift = liveLift }
    move(.immediate) { [self] in dragOffset = TrayDrag.offset(for: grabbedAt + translation) }
  }

  func release(translation: CGFloat, fingerVelocity: CGFloat, refocusesHeldKeyboard: @autoclosure () -> Bool) -> Release {
    guard isDragging else { return .stay }
    let travelled = endDrag(translation: translation)
    let trayVelocity = TrayDrag.trayVelocity(translation: travelled, fingerVelocity: fingerVelocity)
    if TrayDrag.shouldDismiss(translation: travelled, velocity: fingerVelocity, trayHeight: trayHeight) {
      releaseVelocity = trayVelocity
      return .dismiss
    }
    if heldLift != nil, refocusesHeldKeyboard() { isFocused = true }
    settle(velocity: trayVelocity)
    return .stay
  }

  private func endDrag(translation: CGFloat) -> CGFloat {
    isDragging = false
    defer { grabbedAt = 0 }
    return grabbedAt + translation
  }

  private func settle(velocity trayVelocity: CGFloat) {
    let wasHolding = heldLift != nil
    let velocity = Motion.relativeVelocity(trayVelocity, over: -dragOffset)
    move(reduceMotion ? .timing(Motion.reducedMotionCurve) : .spring(Motion.smoothSpring, velocity: velocity)) { [self] in dragOffset = 0 }
    guard wasHolding else { return }
    releaseTask = Task { [weak self] in
      try? await Task.sleep(for: Self.heldLiftGrace)
      guard let self, !Task.isCancelled, !isDragging, heldLift != nil else { return }
      move(.spring(Motion.smoothSpring, velocity: 0)) { [self] in self.heldLift = nil }
    }
  }

  private func keyboardWillMove(to height: CGFloat) {
    keyboardHeight = height
    if isShown, keyboardUp, !isClosing, !hasLanded {
      landingTask?.cancel()
      hasLanded = true
    }
    if let rise, rise.isRunning {
      UIView.performWithoutAnimation { rise.stopAnimation(true) }
    }
    rise = nil
    if !isDragging, let held = heldLift, abs(liveLift - held) < Self.heldLiftTolerance {
      heldLift = nil
    }
    controller.keyboardSentinel.center.y = height
    place()
    if let velocity = pendingFlight?.velocity, !keyboardUp { flyMorph(velocity: velocity) }
  }

  private func face(fitting anchor: BarAnchor) -> BarFaceImage? {
    barFace.flatMap { $0.fits(anchor) ? $0 : nil }
  }

  private var card: CGRect {
    CGRect(
      x: BrowseLayout.panelInset,
      y: 0,
      width: controller.tray.bounds.width - 2 * BrowseLayout.panelInset,
      height: max(trayHeight - BrowseLayout.panelAboveKeyboard, 0)
    )
  }

  private func beginMorph(look: TrayMorphLook, from shownSurface: TrayMorph.Start?) {
    morph = TrayMorph(card: card, fieldCenter: fieldCenter, of: controller.tray, in: controller.view, look: look, from: shownSurface)
    let velocity = releaseVelocity
    move(.immediate) { [self] in
      isClosing = true
      if !keyboardUp { morph?.appear() }
    }
    pendingFlight = PendingFlight(velocity: velocity)
    DispatchQueue.main.async { [weak self] in self?.launchMorph() }
  }

  private func launchMorph() {
    guard let velocity = pendingFlight?.velocity else { return }
    guard keyboardUp else {
      flyMorph(velocity: velocity)
      return
    }
    pendingFlight?.fallback?.cancel()
    pendingFlight?.fallback = Task { [weak self] in
      try? await Task.sleep(for: Self.keyboardGrace)
      guard let self, !Task.isCancelled, let velocity = pendingFlight?.velocity else { return }
      flyMorph(velocity: velocity)
    }
  }

  private func flyMorph(velocity: CGFloat) {
    cancelPendingFlight()
    guard let morph else { return }
    guard let anchor = barAnchor() else {
      morph.vanish()
      hideTrayUnderMorph()
      return
    }
    let target = controller.view.convert(anchor.frame, from: nil)
    let face = face(fitting: anchor)
    if abs(velocity) < Self.stillReleaseSpeed, let clock = KeyboardClock(layer: controller.keyboardSentinel.layer) {
      morph.fly(to: target, style: anchor.style, carrying: face, timing: clock.timing, duration: clock.duration)
    } else {
      let distance = target.midY - morph.view.frame.midY
      let timing = Motion.smoothSpring.timingParameters(initialVelocity: Motion.relativeVelocity(velocity, over: distance))
      morph.fly(to: target, style: anchor.style, carrying: face, timing: timing, duration: Motion.smoothSpring.settlingDuration)
    }
    hideTrayUnderMorph()
  }

  private func cancelPendingFlight() {
    pendingFlight?.fallback?.cancel()
    pendingFlight = nil
  }

  private func hideTrayUnderMorph() {
    UIView.performWithoutAnimation { controller.tray.alpha = 0 }
  }

  private func handOffMorph() {
    cancelPendingFlight()
    fadingMorph?.remove()
    fadingMorph = morph
    morph?.handOff()
    morph = nil
  }

  private func revealContentsNextTurn() {
    guard !revealsContents else { return }
    DispatchQueue.main.async { [weak self] in
      guard let self, !self.revealsContents else { return }
      self.revealsContents = true
    }
  }

  func fieldDidReveal(at base: CFTimeInterval) {
    emergence?.fadeFace(from: base)
  }

  private func endEmergence() {
    emergence?.end(on: controller.tray)
    emergence = nil
    if !revealsContents { revealsContents = true }
  }

  private func dropMorph() {
    cancelPendingFlight()
    morph?.remove()
    morph = nil
    fadingMorph?.remove()
    fadingMorph = nil
  }

  private var liveLift: CGFloat {
    let restsWithoutKeyboard = hasLanded && !keyboardUp && !isClosing
    return restsWithoutKeyboard ? max(keyboardHeight, safeBottom) : keyboardHeight
  }

  private var safeBottom: CGFloat {
    controller.view.window?.safeAreaInsets.bottom ?? 0
  }

  private var isUp: Bool { keyboardUp || (!isClosing && hasLanded) }

  private var isCommandBar: Bool { controller.commandTop != nil }

  private var offscreenDrop: CGFloat { trayHeight + BrowseLayout.sheetTopRadius }

  private var trayOffset: CGFloat {
    let departure = isDeparting ? -BrowseLayout.trayDepartLift : 0
    guard !isCommandBar else { return dragOffset + departure }
    if let emergence, !isUp, !isClosing {
      return emergence.restingOffset(trayHeight: trayHeight, stageBottom: controller.view.bounds.maxY) + dragOffset
    }
    let restingDrop = isUp || isDeparting || reduceMotion ? 0 : offscreenDrop
    return -(heldLift ?? liveLift) + dragOffset + restingDrop + departure
  }

  private func grabMidSpring() -> CGFloat {
    guard let presented = controller.tray.layer.presentation(), controller.tray.layer.animationKeys() != nil else { return TrayDrag.translation(for: dragOffset) }
    let visibleDrag = presented.affineTransform().ty - (trayOffset - dragOffset)
    controller.tray.layer.removeAllAnimations()
    controller.dim.layer.removeAllAnimations()
    return TrayDrag.translation(for: visibleDrag)
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
      let animator = timing.animator {
        changes()
        self.place()
      }
      animator.startAnimation()
      return animator
    }
  }

  private func place() {
    let tray = controller.tray
    let lift = heldLift ?? liveLift
    let scale: CGFloat = isCommandBar && !isUp && !reduceMotion ? Self.commandBarTuckedScale : 1
    tray.isHidden = !isShown
    tray.transform = CGAffineTransform(translationX: 0, y: trayOffset).scaledBy(x: scale, y: scale)
    tray.alpha = trayAlpha
    placeEmergence(on: tray)
    let isUnrevealed = emergence != nil && !isUp
    tray.takesTouches = isShown && !isClosing && !isUnrevealed
    controller.stageView.absorbsTouches = isShown && isClosing
    tray.accessibilityElementsHidden = isUnrevealed
    tray.accessibilityViewIsModal = isShown
    placeDim(progress: TrayDrag.progress(offset: dragOffset, travel: trayHeight + lift))
    if self.lift != lift { self.lift = lift }
  }

  private var trayAlpha: CGFloat {
    if isDeparting || morph?.isShown == true { return 0 }
    return isUp || (!reduceMotion && !isCommandBar) ? 1 : 0
  }

  private func placeEmergence(on tray: UIView) {
    guard let emergence else { return }
    emergence.place(on: tray, in: controller.view, card: card, isOpen: isUp)
    guard isUp else { return }
    emergence.whenSettled { [weak self] in self?.endEmergence() }
    revealContentsNextTurn()
  }

  private func placeDim(progress: CGFloat) {
    let dim = controller.dim
    let shows = isShown && isUp
    dim.backgroundColor = UIColor.black.withAlphaComponent(dimLevel)
    dim.isUserInteractionEnabled = shows && !isClosing
    let alpha = shows ? 1 - progress : 0
    guard shows != dimShown else {
      dim.alpha = alpha
      return
    }
    dimShown = shows
    let fade = reduceMotion ? Motion.fadeCurve : Motion.trayDimCurve
    fade.animator { dim.alpha = alpha }.startAnimation()
  }
}

enum TrayExit {
  case depart
  case morph(TrayMorphLook)
  case drop
}
