import ArdiaDesign
import SwiftUI
import UIKit

@MainActor
final class TrayMorph {
  let view: TrayMorphView
  private(set) var hasFlown = false
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

  init(card: CGRect, fieldCenter: CGFloat, of tray: UIView, in stage: UIView, look: TrayMorphLook, from start: Start?) {
    let cardFrame = tray.convert(card, to: stage).offsetBy(dx: 0, dy: Self.unfinishedTravel(of: tray))
    let snapshot = tray.resizableSnapshotView(from: card, afterScreenUpdates: false, withCapInsets: .zero)
    view = TrayMorphView(look: look, contents: snapshot, cardSize: card.size, fieldCenter: fieldCenter)
    view.shape(to: start?.frame ?? cardFrame, radius: start?.radius ?? BrowseLayout.panelRadius)
    view.isHidden = true
    stage.addSubview(view)
  }

  func fly(to target: CGRect, style: UIUserInterfaceStyle, carrying face: BarFaceImage?, timing: UITimingCurveProvider, duration: TimeInterval) {
    guard !hasFlown else { return }
    hasFlown = true
    destination = target
    appear()
    startFades()
    if let face {
      UIView.performWithoutAnimation { view.carry(face.makeView()) }
      fades.append(Self.run(Motion.trayFaceArrival, after: Motion.trayFaceArrivalDelay) { [view] in view.faceSlot.alpha = 1 })
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
    let fold = UIViewPropertyAnimator(duration: Motion.trayFold.settlingDuration, timingParameters: Motion.trayFold.timingParameters)
    fold.addAnimations { [view] in view.shape(to: folded, radius: target.height / 2) }
    let narrow = UIViewPropertyAnimator(duration: Motion.trayWiden.settlingDuration, timingParameters: Motion.trayWiden.timingParameters)
    narrow.addAnimations { [view] in view.shape(to: target, radius: target.height / 2) }
    travel.startAnimation()
    fold.startAnimation(afterDelay: Motion.trayFoldLag)
    narrow.startAnimation(afterDelay: Motion.trayFoldLag + Motion.trayFold.time(toReach: Motion.trayFoldBeforeNarrowing))
    flight = travel
    folding = [fold, narrow]
  }

  func vanish() {
    guard !hasFlown else { return }
    hasFlown = true
    appear()
    startFades()
    flight = Self.run(Motion.trayHandOff) { [view] in view.alpha = 0 }
  }

  func handOff() {
    if let destination {
      flight?.stopAnimation(true)
      folding.forEach { $0.stopAnimation(true) }
      UIView.performWithoutAnimation {
        view.shape(to: destination, radius: destination.height / 2)
        view.alpha = 0
      }
      DispatchQueue.main.async { self.remove() }
      return
    }
    let fade = Self.run(Motion.trayHandOff) { [view] in view.alpha = 0 }
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

  private func startFades() {
    fades = [
      Self.run(Motion.trayContentFade) { [view] in view.contents.alpha = 0 },
      Self.run(Motion.trayTintFade) { [view] in view.tint.alpha = 0 },
    ]
  }

  private static func unfinishedTravel(of view: UIView) -> CGFloat {
    guard let shown = view.layer.presentation() else { return 0 }
    return shown.affineTransform().ty - view.transform.ty
  }

  private static func gap(between shown: CGRect, and target: CGRect) -> CGFloat {
    max(abs(shown.minX - target.minX), abs(shown.minY - target.minY), abs(shown.maxX - target.maxX), abs(shown.maxY - target.maxY))
  }

  @discardableResult
  private static func run(_ curve: MotionCurve, after delay: TimeInterval = 0, _ changes: @escaping () -> Void) -> UIViewPropertyAnimator {
    let animator = curve.animator(changes)
    animator.startAnimation(afterDelay: delay)
    return animator
  }
}

struct TrayMorphLook {
  var usesGlass: Bool
  var panelTint: UIColor
  var panelStyle: UIUserInterfaceStyle
  var classicPanel: UIColor
}

final class TrayMorphView: UIView {
  fileprivate let tint = UIView()
  fileprivate let contents = UIView()
  fileprivate let faceSlot = UIView()
  private let surface: UIView
  private let classicFill: UIColor?
  private let cardSize: CGSize
  private let fieldCenter: CGFloat
  private(set) var radius: CGFloat = 0

  init(look: TrayMorphLook, contents snapshot: UIView?, cardSize: CGSize, fieldCenter: CGFloat) {
    self.cardSize = cardSize
    self.fieldCenter = fieldCenter
    if look.usesGlass {
      surface = UIVisualEffectView(effect: UIGlassEffect(style: .regular))
      classicFill = nil
    } else {
      surface = UIView()
      surface.backgroundColor = look.classicPanel
      surface.layer.borderWidth = 0.5
      surface.layer.borderColor = UIColor.label.withAlphaComponent(0.12).cgColor
      surface.layer.cornerCurve = .continuous
      classicFill = .systemBackground
    }
    super.init(frame: .zero)
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
    let anchor = fieldAnchor
    faceSlot.center = CGPoint(x: bounds.midX, y: bounds.midY)
    guard let snapshot = contents.subviews.first, cardSize.width > 0 else { return }
    let scale = frame.width / cardSize.width
    snapshot.transform = CGAffineTransform(scaleX: scale, y: scale)
    snapshot.center = CGPoint(x: anchor.x, y: anchor.y + (cardSize.height / 2 - fieldCenter) * scale)
  }

  func settle(style: UIUserInterfaceStyle) {
    surface.overrideUserInterfaceStyle = style
    if let classicFill { surface.backgroundColor = classicFill }
  }

  private var fieldAnchor: CGPoint {
    CGPoint(x: bounds.midX, y: min(fieldCenter, bounds.height / 2))
  }
}
