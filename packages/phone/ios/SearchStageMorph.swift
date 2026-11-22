import ArdiaDesign
import SwiftUI
import UIKit

struct StageAnchor: Equatable {
  var id: String
  var frame: CGRect
  var style: UIUserInterfaceStyle
}

struct StageFace {
  let anchor: StageAnchor
  let image: UIImage

  func fits(_ other: StageAnchor) -> Bool {
    anchor.id == other.id && anchor.style == other.style
      && abs(anchor.frame.width - other.frame.width) < 1 && abs(anchor.frame.height - other.frame.height) < 1
  }

  @MainActor
  func makeView() -> UIView {
    let face = UIImageView(image: image)
    face.frame = CGRect(origin: .zero, size: anchor.frame.size)
    face.isUserInteractionEnabled = false
    return face
  }
}

extension SearchStageView {
  func resolveAnchor() -> StageAnchor? {
    guard let id = anchorNativeId, let root = window, let view = Self.find(nativeId: id, in: root), view.window != nil else { return nil }
    let frame = view.convert(view.bounds, to: nil)
    guard !frame.isEmpty else { return nil }
    return StageAnchor(id: id, frame: frame, style: view.traitCollection.userInterfaceStyle)
  }

  func renderFace(of anchor: StageAnchor) -> StageFace? {
    guard let root = window, let view = Self.find(nativeId: faceNativeId ?? anchor.id, in: root), view.bounds.width > 0, view.bounds.height > 0 else { return nil }
    let size = anchor.frame.size
    let origin = view.convert(view.bounds, to: nil).origin
    let format = UIGraphicsImageRendererFormat.preferred()
    format.opaque = false
    let image = UIGraphicsImageRenderer(size: size, format: format).image { _ in
      let at = CGRect(x: origin.x - anchor.frame.minX, y: origin.y - anchor.frame.minY, width: view.bounds.width, height: view.bounds.height)
      UIGraphicsGetCurrentContext().map { context in
        context.translateBy(x: at.minX, y: at.minY)
        view.layer.render(in: context)
      }
    }
    return StageFace(anchor: anchor, image: image)
  }

  var reduceMotionNow: Bool { reduceMotion }
  var isPresentedAndOpen: Bool { isShown && !isClosing }

  func focusField() {
    guard focusPending, isPresentedAndOpen, let id = focusNativeId else { return }
    guard let field = Self.find(nativeId: id, in: self) as? CompletingFieldView, field.window != nil else { return }
    field.focus()
    focusPending = false
  }

  func holdReveals() {
    for id in [revealNativeId, rowsRevealNativeId].compactMap({ $0 }) {
      guard let view = Self.find(nativeId: id, in: self) else { continue }
      UIView.performWithoutAnimation {
        view.layer.removeAllAnimations()
        view.layer.opacity = 0
      }
    }
  }

  func fadeInReveals(from base: CFTimeInterval) {
    let fades: [(String?, CFTimeInterval)] = [(revealNativeId, Motion.stageRevealFieldDelay), (rowsRevealNativeId, Motion.stageRevealRowsDelay)]
    for (id, delay) in fades {
      guard let id, let view = Self.find(nativeId: id, in: self) else { continue }
      view.restartStageOpacityFade(to: 1, after: reduceMotionNow ? 0 : delay, from: base, curve: Motion.stageRevealCurve)
    }
  }

  static func find(nativeId: String, in view: UIView) -> UIView? {
    let selector = NSSelectorFromString("nativeId")
    if view.responds(to: selector), (view.value(forKey: "nativeId") as? String) == nativeId { return view }
    for child in view.subviews {
      if let found = find(nativeId: nativeId, in: child) { return found }
    }
    return nil
  }
}

struct StageMorphLook {
  var usesGlass = true
  var frosted = false
  var panelTint: UIColor = .clear
  var panelStyle: UIUserInterfaceStyle = .unspecified
  var classicPanel: UIColor = .secondarySystemBackground
  var classicChrome = ClassicChrome()
}

struct StageCardPlace {
  var cardInset: CGFloat = BrowseLayout.panelInset
  var cardGap: CGFloat = BrowseLayout.panelAboveKeyboard
  var fieldInset: CGFloat = BrowseLayout.panelFieldInset
  var fieldTop: CGFloat = BrowseLayout.panelFieldInset
}

struct StageCorners {
  var anchor: CGFloat?
  var panel: CGFloat = BrowseLayout.panelRadius
  var field: CGFloat?

  func anchor(height: CGFloat) -> CGFloat { min(anchor ?? height / 2, height / 2) }
  func field(height: CGFloat) -> CGFloat { min(field ?? height / 2, height / 2) }
}

@MainActor
final class StageEmergence {
  private let pill: CGRect
  private let corners: StageCorners
  private let place: StageCardPlace
  private let fieldCenter: CGFloat
  private let mask = CALayer()
  private let cardLens = CALayer()
  private let fieldLens = CALayer()
  private let shadowLens = CALayer()
  private let face: UIView?
  private var isOpening = false
  private var settling: Task<Void, Never>?

  private struct Span<Value> {
    let from: Value
    let to: Value
  }

  private static let shadowRoom: CGFloat = 18
  private static let fieldClearance: CGFloat = 1
  private static let settlePoll: Duration = .milliseconds(16)
  private static let settleDeadline: Duration = .seconds(1)

  private var isSettled: Bool {
    let lensesIdle = [cardLens, fieldLens, shadowLens].allSatisfy { ($0.animationKeys() ?? []).isEmpty }
    guard isOpening, lensesIdle else { return false }
    guard let face else { return true }
    return face.layer.opacity == 0 && (face.layer.animationKeys() ?? []).isEmpty
  }

  init(pill: CGRect, fieldCenter: CGFloat, corners: StageCorners, place: StageCardPlace, face: UIView?, on tray: UIView) {
    self.pill = pill
    self.corners = corners
    self.place = place
    self.fieldCenter = fieldCenter
    self.face = face
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    for lens in [shadowLens, cardLens, fieldLens] {
      lens.backgroundColor = UIColor.black.cgColor
      lens.cornerCurve = .continuous
      mask.addSublayer(lens)
    }
    shadowLens.opacity = 0
    mask.frame = tray.bounds
    tray.layer.mask = mask
    CATransaction.commit()
    if let face { tray.addSubview(face) }
  }

  func restingOffset(trayHeight: CGFloat, stageBottom: CGFloat) -> CGFloat {
    pill.midY - fieldCenter + trayHeight - stageBottom
  }

  func place(on tray: UIView, in stage: UIView, card: CGRect, isOpen: Bool) {
    let closed = stage.convert(pill, to: tray)
    let cardWindow = isOpen ? card : closed
    let field = isOpen ? fieldFrame(in: card) : closed
    let before = (card: cardLens.frame, field: fieldLens.frame, radius: cardLens.cornerRadius)
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    mask.frame = tray.bounds
    cardLens.frame = cardWindow
    cardLens.cornerRadius = isOpen ? corners.panel : corners.anchor(height: closed.height)
    fieldLens.frame = field
    fieldLens.cornerRadius = isOpen ? corners.field(height: field.height) : corners.anchor(height: field.height)
    shadowLens.frame = card.insetBy(dx: -Self.shadowRoom, dy: -Self.shadowRoom)
    shadowLens.cornerRadius = corners.panel + Self.shadowRoom
    CATransaction.commit()
    UIView.performWithoutAnimation { face?.center = CGPoint(x: card.midX, y: fieldCenter) }
    guard isOpen, !isOpening else { return }
    isOpening = true
    unfold(card: Span(from: before.card, to: cardWindow), field: Span(from: before.field, to: field), radius: Span(from: before.radius, to: cardLens.cornerRadius))
  }

  func whenSettled(_ settled: @escaping @MainActor () -> Void) {
    guard settling == nil else { return }
    settling = Task { [weak self] in
      guard await StageSettlePoll.until(every: Self.settlePoll, within: Self.settleDeadline, { self?.isSettled != false }) else { return }
      settled()
    }
  }

  func fadeFace(from base: CFTimeInterval) {
    guard let face, face.layer.opacity > 0 else { return }
    face.restartStageOpacityFade(to: 0, after: Motion.stageRevealFieldDelay - Motion.stageFaceLead, from: base, curve: Motion.stageFaceFade)
  }

  func shownSurface(of tray: UIView, card: CGRect, in stage: UIView) -> StageMorph.Start {
    let cardNow = (cardLens.presentation() ?? cardLens).frame
    let fieldNow = (fieldLens.presentation() ?? fieldLens).frame
    let shown = tray.layer.presentation() ?? tray.layer
    let window = cardNow.union(fieldNow).intersection(card)
    let frame = shown.convert(window.isNull ? card : window, to: stage.layer.presentation() ?? stage.layer)
    let radiusNow = (cardLens.presentation() ?? cardLens).cornerRadius
    return StageMorph.Start(frame: frame, radius: min(radiusNow, frame.height / 2))
  }

  func end(on tray: UIView) {
    settling?.cancel()
    settling = nil
    if tray.layer.mask === mask {
      CATransaction.begin()
      CATransaction.setDisableActions(true)
      tray.layer.mask = nil
      CATransaction.commit()
    }
    face?.removeFromSuperview()
  }

  private func fieldFrame(in card: CGRect) -> CGRect {
    let height = 2 * (fieldCenter - place.fieldTop) + 2 * Self.fieldClearance
    return CGRect(
      x: card.minX + place.fieldInset - Self.fieldClearance,
      y: fieldCenter - height / 2,
      width: card.width - 2 * place.fieldInset + 2 * Self.fieldClearance,
      height: height
    )
  }

  private func unfold(card: Span<CGRect>, field: Span<CGRect>, radius: Span<CGFloat>) {
    let needed = card.to.width > card.from.width ? (field.to.width - card.from.width) / (card.to.width - card.from.width) : 0
    let deepenAt = Motion.stageOpenWiden.time(toReach: needed)
    Self.group(on: fieldLens, [
      Self.spring("bounds.size.width", field.from.width, field.to.width, on: Motion.stageOpenWiden),
      Self.spring("position.x", field.from.midX, field.to.midX, on: Motion.stageOpenWiden),
      Self.spring("bounds.size.height", field.from.height, field.to.height, on: Motion.stageOpenWiden),
      Self.spring("position.y", field.from.midY, field.to.midY, on: Motion.stageOpenWiden),
      Self.spring("cornerRadius", corners.anchor(height: field.from.height), corners.field(height: field.to.height), on: Motion.stageOpenWiden),
    ])
    Self.group(on: cardLens, [
      Self.spring("bounds.size.width", card.from.width, card.to.width, on: Motion.stageOpenWiden),
      Self.spring("position.x", card.from.midX, card.to.midX, on: Motion.stageOpenWiden),
      Self.spring("bounds.size.height", card.from.height, card.to.height, on: Motion.stageDeepen, after: deepenAt),
      Self.spring("position.y", card.from.midY, card.to.midY, on: Motion.stageDeepen, after: deepenAt),
      Self.deepeningRadius(heights: Span(from: card.from.height, to: card.to.height), radii: radius, on: Motion.stageDeepen, after: deepenAt),
    ])
    let shadowFade = CABasicAnimation(keyPath: "opacity")
    shadowFade.fromValue = 0
    shadowFade.toValue = 1
    shadowFade.beginTime = deepenAt + Motion.stageDeepen.duration
    shadowFade.duration = Motion.stageShadowIn.duration
    shadowFade.timingFunction = Motion.stageShadowIn.stageTimingFunction
    shadowFade.fillMode = .backwards
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    shadowLens.opacity = 1
    CATransaction.commit()
    Self.group(on: shadowLens, [shadowFade])
  }

  private static func spring(_ keyPath: String, _ from: CGFloat, _ to: CGFloat, on timing: Spring, after delay: CFTimeInterval = 0) -> CAAnimation {
    let spring = CASpringAnimation(perceptualDuration: timing.duration, bounce: timing.bounce)
    spring.keyPath = keyPath
    spring.fromValue = from
    spring.toValue = to
    spring.duration = spring.settlingDuration
    spring.beginTime = delay
    spring.fillMode = .backwards
    return spring
  }

  private static func deepeningRadius(heights: Span<CGFloat>, radii: Span<CGFloat>, on timing: Spring, after delay: CFTimeInterval) -> CAAnimation {
    let steps = max(Int(timing.settlingDuration * 120), 2)
    var values: [CGFloat] = []
    var keyTimes: [NSNumber] = []
    for step in 0...steps {
      let fraction = Double(step) / Double(steps)
      let progress = timing.criticalProgress(at: fraction * timing.settlingDuration)
      let height = heights.from + (heights.to - heights.from) * CGFloat(progress)
      let radius = radii.from + (radii.to - radii.from) * CGFloat(progress)
      values.append(min(height / 2, radius))
      keyTimes.append(NSNumber(value: fraction))
    }
    let animation = CAKeyframeAnimation(keyPath: "cornerRadius")
    animation.values = values
    animation.keyTimes = keyTimes
    animation.calculationMode = .linear
    animation.duration = timing.settlingDuration
    animation.beginTime = delay
    animation.fillMode = .backwards
    return animation
  }

  private static func group(on layer: CALayer, _ animations: [CAAnimation]) {
    let group = CAAnimationGroup()
    group.animations = animations
    group.duration = animations.map { $0.beginTime + $0.duration }.max() ?? 0
    layer.add(group, forKey: "unfold")
  }
}

@MainActor
final class StageMorph {
  let view: StageMorphView
  private(set) var hasFlown = false
  private let corners: StageCorners
  private let startsFromEmergence: Bool
  private var destination: CGRect?
  private var flight: UIViewPropertyAnimator?
  private var folding: [UIViewPropertyAnimator] = []
  private var fades: [UIViewPropertyAnimator] = []

  private static let landedTolerance: CGFloat = 0.17

  struct Start {
    var frame: CGRect
    var radius: CGFloat
  }

  var hasDestination: Bool { destination != nil }
  var isShown: Bool { !view.isHidden }

  var isMoving: Bool {
    guard let flight, flight.isRunning || folding.contains(where: \.isRunning) else { return false }
    guard let destination, let shown = view.layer.presentation()?.frame else { return true }
    return Self.gap(between: shown, and: destination) > Self.landedTolerance
  }

  init(card: CGRect, fieldCenter: CGFloat, corners: StageCorners, of tray: UIView, in stage: UIView, look: StageMorphLook, from start: Start?) {
    self.corners = corners
    startsFromEmergence = start != nil
    let cardFrame = tray.convert(card, to: stage).offsetBy(dx: 0, dy: Self.unfinishedTravel(of: tray))
    let snapshot = tray.resizableSnapshotView(from: card, afterScreenUpdates: false, withCapInsets: .zero)
    view = StageMorphView(look: look, contents: snapshot, cardSize: card.size, fieldCenter: fieldCenter)
    view.shape(to: start?.frame ?? cardFrame, radius: start?.radius ?? corners.panel)
    view.isHidden = true
    stage.addSubview(view)
  }

  func fly(to target: CGRect, style: UIUserInterfaceStyle, carrying face: StageFace?, timing: UITimingCurveProvider, duration: TimeInterval, direct: Bool = false) {
    guard !hasFlown else { return }
    hasFlown = true
    destination = target
    appear()
    startFades()
    if let face {
      UIView.performWithoutAnimation { view.carry(face.makeView()) }
      fades.append(Self.run(Motion.stageFaceArrival, after: Motion.stageFaceArrivalDelay) { [view] in view.faceSlot.alpha = 1 })
    }
    if direct {
      let travel = UIViewPropertyAnimator(duration: duration, timingParameters: timing)
      let landed = corners.anchor(height: target.height)
      travel.addAnimations { [view] in
        view.shape(to: target, radius: landed)
        view.settle(style: style)
      }
      travel.startAnimation()
      flight = travel
      folding = []
      return
    }
    let start = view.frame
    let radius = view.radius
    let dropped = CGRect(x: start.minX, y: target.midY - start.height / 2, width: start.width, height: start.height)
    let folded = CGRect(x: start.minX, y: target.midY - target.height / 2, width: start.width, height: target.height)
    let travel = UIViewPropertyAnimator(duration: duration, timingParameters: timing)
    travel.addAnimations { [view] in
      view.shape(to: dropped, radius: radius)
      view.settle(style: style)
    }
    let fold = UIViewPropertyAnimator(duration: Motion.stageFold.settlingDuration, timingParameters: Motion.stageFold.stageTimingParameters)
    let landed = corners.anchor(height: target.height)
    fold.addAnimations { [view] in view.shape(to: folded, radius: landed) }
    let narrow = UIViewPropertyAnimator(duration: Motion.stageWiden.settlingDuration, timingParameters: Motion.stageWiden.stageTimingParameters)
    narrow.addAnimations { [view] in view.shape(to: target, radius: landed) }
    travel.startAnimation()
    fold.startAnimation(afterDelay: Motion.stageFoldLag)
    narrow.startAnimation(afterDelay: Motion.stageFoldLag + Motion.stageFold.time(toReach: Motion.stageFoldBeforeNarrowing))
    flight = travel
    folding = [fold, narrow]
  }

  func vanish() {
    guard !hasFlown else { return }
    hasFlown = true
    appear()
    startFades()
    flight = Self.run(Motion.stageHandOff) { [view] in view.alpha = 0 }
  }

  func handOff() {
    if let destination {
      flight?.stopAnimation(true)
      folding.forEach { $0.stopAnimation(true) }
      UIView.performWithoutAnimation {
        view.shape(to: destination, radius: corners.anchor(height: destination.height))
        view.alpha = 0
      }
      DispatchQueue.main.async { self.remove() }
      return
    }
    let fade = Self.run(Motion.stageHandOff) { [view] in view.alpha = 0 }
    fade.addCompletion { _ in self.remove() }
  }

  func remove() {
    folding.forEach { $0.stopAnimation(true) }
    flight?.stopAnimation(true)
    fades.forEach { $0.stopAnimation(true) }
    view.removeFromSuperview()
  }

  func appear() {
    UIView.performWithoutAnimation { view.isHidden = false }
  }

  func restart(fromCard card: CGRect, of tray: UIView, in stage: UIView) {
    guard !hasFlown, !startsFromEmergence else { return }
    let frame = Self.shownCard(card, of: tray, in: stage)
    guard !frame.isEmpty else { return }
    UIView.performWithoutAnimation { view.shape(to: frame, radius: min(view.radius, frame.height / 2)) }
  }

  private static func shownCard(_ card: CGRect, of tray: UIView, in stage: UIView) -> CGRect {
    let shown = (tray.layer.presentation() ?? tray.layer).convert(card, to: stage.layer.presentation() ?? stage.layer)
    guard shown.maxY > stage.bounds.maxY else { return shown }
    return CGRect(x: shown.minX, y: shown.minY, width: shown.width, height: max(stage.bounds.maxY - shown.minY, 0))
  }

  private func startFades() {
    fades = [
      Self.run(Motion.stageContentFade) { [view] in view.contents.alpha = 0 },
      Self.run(Motion.stageTintFade) { [view] in view.tint.alpha = 0 },
    ]
  }

  private static func unfinishedTravel(of view: UIView) -> CGFloat {
    guard !(view.layer.animationKeys() ?? []).isEmpty, let shown = view.layer.presentation() else { return 0 }
    return shown.affineTransform().ty - view.transform.ty
  }

  private static func gap(between shown: CGRect, and target: CGRect) -> CGFloat {
    max(abs(shown.minX - target.minX), abs(shown.minY - target.minY), abs(shown.maxX - target.maxX), abs(shown.maxY - target.maxY))
  }

  @discardableResult
  private static func run(_ curve: ArdiaDesign.MotionCurve, after delay: TimeInterval = 0, _ changes: @escaping () -> Void) -> UIViewPropertyAnimator {
    let animator = curve.stageAnimator(changes)
    animator.startAnimation(afterDelay: delay)
    return animator
  }
}

final class StageMorphView: UIView {
  fileprivate let tint = UIView()
  fileprivate let contents = UIView()
  fileprivate let faceSlot = UIView()
  private let surface: UIView
  private let classicFill: UIColor?
  private let cardSize: CGSize
  private let fieldCenter: CGFloat
  private(set) var radius: CGFloat = 0

  init(look: StageMorphLook, contents snapshot: UIView?, cardSize: CGSize, fieldCenter: CGFloat) {
    self.cardSize = cardSize
    self.fieldCenter = fieldCenter
    if look.usesGlass {
      surface = UIVisualEffectView(effect: UIGlassEffect(style: .regular))
      classicFill = nil
    } else if look.frosted {
      let frost = UIVisualEffectView(effect: UIBlurEffect(style: .systemUltraThinMaterial))
      frost.contentView.backgroundColor = look.classicPanel
      frost.clipsToBounds = true
      frost.layer.cornerCurve = .continuous
      surface = frost
      classicFill = .systemBackground
    } else {
      surface = UIView()
      surface.backgroundColor = look.classicPanel
      let edgeTraits = look.panelStyle == .unspecified ? UITraitCollection.current : UITraitCollection(userInterfaceStyle: look.panelStyle)
      surface.layer.borderWidth = CGFloat(look.classicChrome.edgeWidth)
      surface.layer.borderColor = look.classicChrome.edge?.resolvedColor(with: edgeTraits).cgColor
      surface.layer.cornerCurve = .continuous
      classicFill = .systemBackground
    }
    super.init(frame: .zero)
    surface.layer.cornerCurve = .continuous
    isUserInteractionEnabled = false
    accessibilityElementsHidden = true
    contents.clipsToBounds = true
    contents.layer.cornerCurve = .continuous
    faceSlot.alpha = 0
    surface.overrideUserInterfaceStyle = look.panelStyle
    tint.backgroundColor = look.panelTint
    tint.overrideUserInterfaceStyle = look.panelStyle
    tint.layer.cornerCurve = .continuous
    tint.clipsToBounds = true
    let layers = look.usesGlass ? [tint, surface, contents, faceSlot] : [surface, tint, contents, faceSlot]
    layers.forEach(addSubview)
    if let snapshot {
      snapshot.frame = CGRect(origin: .zero, size: cardSize)
      contents.addSubview(snapshot)
    }
  }

  required init?(coder: NSCoder) { nil }

  func carry(_ face: UIView) {
    faceSlot.subviews.forEach { $0.removeFromSuperview() }
    faceSlot.bounds = CGRect(origin: .zero, size: face.bounds.size)
    faceSlot.center = CGPoint(x: bounds.midX, y: bounds.midY)
    face.frame.origin = .zero
    faceSlot.addSubview(face)
  }

  func shape(to frame: CGRect, radius: CGFloat) {
    self.radius = radius
    self.frame = frame
    let bounds = CGRect(origin: .zero, size: frame.size)
    for piece in [surface, tint, contents] {
      piece.frame = bounds
    }
    if let glass = surface as? UIVisualEffectView {
      glass.cornerConfiguration = .uniformCorners(radius: .fixed(radius))
    } else {
      surface.layer.cornerRadius = radius
    }
    tint.layer.cornerRadius = radius
    contents.layer.cornerRadius = radius
    let anchor = CGPoint(x: bounds.midX, y: min(fieldCenter, bounds.height / 2))
    faceSlot.center = CGPoint(x: bounds.midX, y: bounds.midY)
    guard let snapshot = contents.subviews.first, cardSize.width > 0 else { return }
    let scale = frame.width / cardSize.width
    snapshot.transform = CGAffineTransform(scaleX: scale, y: scale)
    snapshot.center = CGPoint(x: anchor.x, y: anchor.y + (cardSize.height / 2 - fieldCenter) * scale)
  }

  func settle(style: UIUserInterfaceStyle) {
    surface.overrideUserInterfaceStyle = style
    guard let classicFill else { return }
    if let frost = surface as? UIVisualEffectView {
      frost.contentView.backgroundColor = classicFill
    } else {
      surface.backgroundColor = classicFill
    }
  }
}
